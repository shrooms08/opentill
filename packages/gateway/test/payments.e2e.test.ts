import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySignature } from "../src/webhooks";
import { createInvoice, expireDueInvoices } from "../src/domain/invoices";
import {
  authHeaders,
  makeHarness,
  sleep,
  startWebhookSink,
  waitUntil,
  WEBHOOK_SECRET,
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

async function createViaApi(body: Record<string, unknown>): Promise<Record<string, string>> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: authHeaders(),
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json<Record<string, string>>();
}

async function fetchInvoice(id: string): Promise<Record<string, unknown>> {
  const res = await h.app.inject({
    method: "GET",
    url: `/api/invoices/${id}`,
    headers: authHeaders(),
  });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
}

/** Poll until the payment has committed on the mock, then apply it. */
async function tickUntilCommitted(): Promise<void> {
  h.mock.forceCommitAll();
  await h.poller.tick();
}

describe("happy path", () => {
  it("create -> simulate -> paid -> confirmed, with signed webhooks", async () => {
    const invoice = await createViaApi({
      amountSats: "50000",
      memo: "Flat white",
      orderId: "order-1",
      webhookUrl: sink.url,
    });

    expect(invoice.status).toBe("pending");
    expect(invoice.address).toMatch(/^mock1p/);
    expect(invoice.paymentUri).toBe(
      `bitcoin:${invoice.address}?amount=0.0005&label=Flat+white`,
    );

    const sim = await h.app.inject({
      method: "POST",
      url: "/dev/simulate-payment",
      headers: authHeaders(),
      payload: { address: invoice.address, amountSats: "50000" },
    });
    expect(sim.statusCode).toBe(202);

    await h.poller.tick();
    expect((await fetchInvoice(invoice.id!)).status).toBe("paid");

    // Still only `seen` on the settlement layer: another poll must not confirm it.
    await h.poller.tick();
    expect((await fetchInvoice(invoice.id!)).status).toBe("paid");

    await tickUntilCommitted();

    const confirmed = await fetchInvoice(invoice.id!);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.amountPaidSats).toBe("50000");
    expect(confirmed.payments).toHaveLength(1);
    expect((confirmed.payments as Array<Record<string, unknown>>)[0]?.status).toBe("committed");

    const hooks = await sink.waitFor(2);
    expect(hooks.map((w) => w.parsed.status)).toEqual(["paid", "confirmed"]);
    expect(hooks[0]?.parsed).toMatchObject({
      invoiceId: invoice.id,
      orderId: "order-1",
      previousStatus: "pending",
      status: "paid",
      amountSats: "50000",
      amountPaidSats: "50000",
    });

    for (const hook of hooks) {
      expect(hook.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(verifySignature(hook.body, hook.signature, WEBHOOK_SECRET)).toBe(true);
      expect(verifySignature(hook.body, hook.signature, "wrong_secret")).toBe(false);
    }

    // The sink sees the request slightly before the dispatcher records the result.
    await waitUntil(
      () => h.repo.listWebhooksForInvoice(invoice.id!).every((d) => d.status === "delivered"),
      "both deliveries recorded",
    );
    const deliveries = h.repo.listWebhooksForInvoice(invoice.id!);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === "delivered" && d.attempts === 1)).toBe(true);
  });
});

describe("expiry", () => {
  it("expires a pending invoice and records later payments as late without changing state", async () => {
    // Backdate creation so the invoice is already past its deadline.
    const invoice = await createInvoice(
      h.ctx,
      { amountSats: "10000", webhookUrl: sink.url, expiresInSeconds: 30 },
      Date.now() - 60_000,
    );
    await h.adapter.watchAddress(invoice.address);

    expect(expireDueInvoices(h.ctx)).toBe(1);
    expect(h.repo.getInvoice(invoice.id)?.status).toBe("expired");

    h.mock.simulateIncomingPayment(invoice.address, 10_000n);
    await h.poller.tick();
    await tickUntilCommitted();

    const after = h.repo.getInvoice(invoice.id);
    expect(after?.status).toBe("expired");
    expect(after?.amountPaidSats).toBe(0n);

    const payments = h.repo.listPaymentsForInvoice(invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]?.latePayment).toBe(true);
    expect(payments[0]?.amountSats).toBe(10_000n);

    // Exactly one webhook: the expiry. The late payment must not emit one.
    const hooks = await sink.waitFor(1);
    await sleep(50);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.parsed).toMatchObject({ previousStatus: "pending", status: "expired" });
  });
});

describe("underpayment and overpayment", () => {
  it("marks an underpaid invoice terminal and records the shortfall", async () => {
    const invoice = await createViaApi({ amountSats: "10000", webhookUrl: sink.url });

    h.mock.simulateIncomingPayment(invoice.address!, 4_000n);
    await h.poller.tick();

    const under = await fetchInvoice(invoice.id!);
    expect(under.status).toBe("underpaid");
    expect(under.amountPaidSats).toBe("4000");
    expect(under.shortfallSats).toBe("6000");

    // Still short: the commit event alone must not advance it — only a
    // credit that covers the shortfall does (Gate 3 top-up flow).
    await tickUntilCommitted();
    expect((await fetchInvoice(invoice.id!)).status).toBe("underpaid");

    const hooks = await sink.waitFor(1);
    expect(hooks[0]?.parsed).toMatchObject({ status: "underpaid", amountPaidSats: "4000" });
  });

  it("confirms an overpaid invoice and keeps amountPaidSats distinct from amountSats", async () => {
    const invoice = await createViaApi({ amountSats: "10000", webhookUrl: sink.url });

    h.mock.simulateIncomingPayment(invoice.address!, 15_000n);
    await h.poller.tick();

    const paid = await fetchInvoice(invoice.id!);
    expect(paid.status).toBe("paid");
    expect(paid.amountSats).toBe("10000");
    expect(paid.amountPaidSats).toBe("15000");
    expect(paid.shortfallSats).toBeNull();

    await tickUntilCommitted();
    const confirmed = await fetchInvoice(invoice.id!);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.amountPaidSats).toBe("15000");
  });
});

describe("idempotency", () => {
  it("applies a replayed poll batch exactly once", async () => {
    const invoice = await createViaApi({ amountSats: "10000", webhookUrl: sink.url });
    h.mock.simulateIncomingPayment(invoice.address!, 12_000n);

    const before = h.repo.getCursor();
    await h.poller.tick();

    const afterFirst = h.repo.getInvoice(invoice.id!);
    expect(afterFirst?.status).toBe("paid");
    expect(afterFirst?.amountPaidSats).toBe(12_000n);

    // Simulate a crash between the adapter call and the commit: rewind the
    // cursor so the very same events are delivered again.
    h.repo.setCursor(before ?? "0");
    await h.poller.tick();
    await h.poller.tick();

    const afterReplay = h.repo.getInvoice(invoice.id!);
    expect(afterReplay?.status).toBe("paid");
    expect(afterReplay?.amountPaidSats).toBe(12_000n);
    expect(h.repo.listPaymentsForInvoice(invoice.id!)).toHaveLength(1);
    expect(h.repo.listWebhooksForInvoice(invoice.id!)).toHaveLength(1);

    // The commit event still lands exactly once, moving it to confirmed.
    await tickUntilCommitted();
    await tickUntilCommitted();

    expect(h.repo.getInvoice(invoice.id!)?.status).toBe("confirmed");
    expect(h.repo.listPaymentsForInvoice(invoice.id!)).toHaveLength(1);
    expect(h.repo.listWebhooksForInvoice(invoice.id!)).toHaveLength(2);
  });

  it("persists the cursor in the same transaction as the state change", async () => {
    const invoice = await createViaApi({ amountSats: "1000" });
    h.mock.simulateIncomingPayment(invoice.address!, 1_000n);

    expect(h.repo.getCursor()).toBeNull();
    const result = await h.poller.tick();

    expect(result.applied).toBe(1);
    expect(h.repo.getCursor()).toBe(result.cursor);
    expect(h.repo.getInvoice(invoice.id!)?.status).toBe("paid");
  });
});
