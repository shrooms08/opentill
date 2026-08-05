import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WEBHOOK_BACKOFF_MS, WEBHOOK_MAX_ATTEMPTS } from "@opentill/shared";
import { signBody, verifySignature } from "../src/webhooks";
import {
  authHeaders,
  makeHarness,
  startWebhookSink,
  waitUntil,
  type Harness,
  type WebhookSink,
} from "./helpers";

let h: Harness;
let sink: WebhookSink;

beforeEach(async () => {
  h = await makeHarness();
  sink = await startWebhookSink();
});

afterEach(async () => {
  await h.destroy();
  await sink.close();
});

async function createAndPay(webhookUrl: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: authHeaders(),
    payload: { amountSats: "1000", webhookUrl },
  });
  const invoice = res.json<{ id: string; address: string }>();
  h.mock.simulateIncomingPayment(invoice.address, 1000n);
  await h.poller.tick();
  return invoice.id;
}

describe("signatures", () => {
  it("verifies only against the right secret and body", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signBody(body, "s3cret");
    expect(verifySignature(body, sig, "s3cret")).toBe(true);
    expect(verifySignature(body, sig, "other")).toBe(false);
    expect(verifySignature(`${body} `, sig, "s3cret")).toBe(false);
    expect(verifySignature(body, "short", "s3cret")).toBe(false);
  });
});

describe("delivery", () => {
  it("does not enqueue anything when the invoice has no webhookUrl", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: authHeaders(),
      payload: { amountSats: "1000" },
    });
    const invoice = res.json<{ id: string; address: string }>();
    h.mock.simulateIncomingPayment(invoice.address, 1000n);
    await h.poller.tick();

    expect(h.repo.getInvoice(invoice.id)?.status).toBe("paid");
    expect(h.repo.listWebhooksForInvoice(invoice.id)).toHaveLength(0);
  });

  it("retries with the documented backoff and eventually gives up", async () => {
    const before = Date.now();
    sink.setResponseStatus(500);
    const invoiceId = await createAndPay(sink.url);
    await sink.waitFor(1);
    // The sink sees the request before the dispatcher records the attempt;
    // wait for the recording too so the assertions below are race-free.
    await waitUntil(
      () => (h.repo.listWebhooksForInvoice(invoiceId)[0]?.attempts ?? 0) >= 1,
      "first attempt recorded",
    );

    let delivery = h.repo.listWebhooksForInvoice(invoiceId)[0]!;
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastStatusCode).toBe(500);
    // Next attempt is scheduled one full backoff step after the (failed)
    // attempt, which itself happened at or after `before` — no wall-clock
    // margin needed, so this holds under any test-runner load.
    expect(delivery.nextAttemptAt).toBeGreaterThanOrEqual(before + WEBHOOK_BACKOFF_MS[1]!);

    // A sweep before the scheduled time is a no-op.
    expect(await h.webhooks.sweep(delivery.nextAttemptAt - 1)).toBe(0);
    expect(h.repo.getWebhook(delivery.id)?.attempts).toBe(1);

    // Fast-forward by sweeping with a future clock, once per remaining attempt.
    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      await h.webhooks.sweep(Date.now() + 60 * 60_000);
      delivery = h.repo.getWebhook(delivery.id)!;
      expect(delivery.attempts).toBe(attempt);
    }

    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(sink.received).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    // Every retry carries the identical signed body.
    const bodies = new Set(sink.received.map((r) => r.body));
    expect(bodies.size).toBe(1);

    // Exhausted deliveries are not retried again.
    await h.webhooks.sweep(Date.now() + 24 * 60 * 60_000);
    expect(sink.received).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
  });

  it("recovers when the endpoint comes back before attempts run out", async () => {
    sink.setResponseStatus(503);
    const invoiceId = await createAndPay(sink.url);
    await sink.waitFor(1);

    sink.setResponseStatus(200);
    await h.webhooks.sweep(Date.now() + 60_000);

    const delivery = h.repo.listWebhooksForInvoice(invoiceId)[0]!;
    expect(delivery.status).toBe("delivered");
    expect(delivery.attempts).toBe(2);
  });

  it("records a transport failure when the endpoint is unreachable", async () => {
    const invoiceId = await createAndPay("http://127.0.0.1:1/hook");
    await h.webhooks.sweep();

    const delivery = h.repo.listWebhooksForInvoice(invoiceId)[0]!;
    expect(delivery.attempts).toBeGreaterThanOrEqual(1);
    expect(delivery.status).toBe("pending");
    expect(delivery.lastStatusCode).toBeNull();
    expect(delivery.lastError).toBeTruthy();
  });
});
