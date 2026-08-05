import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatsDTO, WebhookDeliveryDTO } from "@opentill/shared";
import { expireDueInvoices } from "../src/domain/invoices";
import {
  authHeaders,
  makeHarness,
  startWebhookSink,
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

/** Simulate + tick, then commit everything outstanding + tick: lands in confirmed. */
async function confirmedInvoice(amountSats: string, paidSats?: string): Promise<string> {
  const invoice = await createViaApi({ amountSats });
  h.mock.simulateIncomingPayment(invoice.address!, BigInt(paidSats ?? amountSats));
  await h.poller.tick();
  h.mock.forceCommitAll();
  await h.poller.tick();
  expect((await fetchInvoice(invoice.id!)).status).toBe("confirmed");
  return invoice.id!;
}

describe("underpaid top-ups (Part A)", () => {
  it("single top-up crossing the threshold: underpaid -> paid -> confirmed, with webhooks", async () => {
    const invoice = await createViaApi({ amountSats: "10000", webhookUrl: sink.url });

    h.mock.simulateIncomingPayment(invoice.address!, 4_000n);
    await h.poller.tick();
    const under = await fetchInvoice(invoice.id!);
    expect(under.status).toBe("underpaid");
    expect(under.shortfallSats).toBe("6000");

    h.mock.simulateIncomingPayment(invoice.address!, 6_000n);
    await h.poller.tick();
    const paid = await fetchInvoice(invoice.id!);
    expect(paid.status).toBe("paid");
    expect(paid.amountPaidSats).toBe("10000");
    expect(paid.shortfallSats).toBeNull();

    h.mock.forceCommitAll();
    await h.poller.tick();
    const confirmed = await fetchInvoice(invoice.id!);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).toBeTypeOf("number");

    const hooks = await sink.waitFor(3);
    expect(hooks.map((w) => w.parsed.status)).toEqual(["underpaid", "paid", "confirmed"]);
    expect(hooks[1]?.parsed).toMatchObject({
      previousStatus: "underpaid",
      status: "paid",
      amountPaidSats: "10000",
    });
  });

  it("a still-short top-up shrinks the shortfall without leaving underpaid", async () => {
    const invoice = await createViaApi({ amountSats: "10000" });

    h.mock.simulateIncomingPayment(invoice.address!, 4_000n);
    await h.poller.tick();
    h.mock.simulateIncomingPayment(invoice.address!, 3_000n);
    await h.poller.tick();

    const still = await fetchInvoice(invoice.id!);
    expect(still.status).toBe("underpaid");
    expect(still.amountPaidSats).toBe("7000");
    expect(still.shortfallSats).toBe("3000");
  });

  it("confirms only when EVERY credited payment has committed", async () => {
    const invoice = await createViaApi({ amountSats: "10000" });

    // p1: partial, then committed while the invoice is still underpaid.
    h.mock.simulateIncomingPayment(invoice.address!, 4_000n);
    await h.poller.tick();
    h.mock.forceCommitAll();
    await h.poller.tick();
    expect((await fetchInvoice(invoice.id!)).status).toBe("underpaid");

    // p2 covers the shortfall but is only `seen`: paid, NOT confirmed —
    // p1 is committed but p2 (also counted toward the threshold) is not.
    h.mock.simulateIncomingPayment(invoice.address!, 6_000n);
    await h.poller.tick();
    expect((await fetchInvoice(invoice.id!)).status).toBe("paid");
    await h.poller.tick();
    expect((await fetchInvoice(invoice.id!)).status).toBe("paid");

    // p2 commits: now everything credited is committed -> confirmed.
    h.mock.forceCommitAll();
    await h.poller.tick();
    expect((await fetchInvoice(invoice.id!)).status).toBe("confirmed");
  });
});

describe("GET /api/stats (Part B)", () => {
  it("aggregates exact numbers including the 24h window edge", async () => {
    // Three confirmed (10000, 5000 paid 7000 overpaid, 8000), one refunded.
    const a = await confirmedInvoice("10000");
    const b = await confirmedInvoice("5000", "7000");
    const c = await confirmedInvoice("8000");
    const g = await confirmedInvoice("6000");
    const refund = await h.app.inject({
      method: "POST",
      url: `/api/invoices/${g}/refund`,
      headers: authHeaders(),
      payload: { toAddress: "mock1pcustomer" },
    });
    expect(refund.statusCode).toBe(200);

    // One underpaid.
    const e = await createViaApi({ amountSats: "10000" });
    h.mock.simulateIncomingPayment(e.address!, 4_000n);
    await h.poller.tick();

    // One expired (before the pending fixture exists, so the sweep only hits it).
    const f = await createViaApi({ amountSats: "1000", expiresInSeconds: 30 });
    expireDueInvoices(h.ctx, Date.now() + 31_000);
    expect((await fetchInvoice(f.id!)).status).toBe("expired");

    // One pending.
    await createViaApi({ amountSats: "1000" });

    // Pin the 24h edge: b confirmed 23h59m ago (in), c 24h01m ago (out).
    const now = Date.now();
    const set = h.db.prepare("UPDATE invoices SET confirmed_at = ? WHERE id = ?");
    set.run(now - (24 * 60 - 1) * 60 * 1000, b);
    set.run(now - (24 * 60 + 1) * 60 * 1000, c);

    const res = await h.app.inject({ method: "GET", url: "/api/stats", headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const stats = res.json<StatsDTO>();

    expect(stats).toEqual({
      confirmedCount: 3,
      confirmedTotalSats: "25000", // 10000 + 7000 (overpaid) + 8000
      pendingCount: 1,
      refundedCount: 1,
      refundedTotalSats: "6000",
      underpaidCount: 1,
      expiredCount: 1,
      last24h: {
        confirmedCount: 2, // a (just now) + b (23h59m); c fell out
        confirmedTotalSats: "17000",
      },
    });
    void a;
  });

  it("returns zeros on an empty database", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/stats", headers: authHeaders() });
    expect(res.json<StatsDTO>()).toEqual({
      confirmedCount: 0,
      confirmedTotalSats: "0",
      pendingCount: 0,
      refundedCount: 0,
      refundedTotalSats: "0",
      underpaidCount: 0,
      expiredCount: 0,
      last24h: { confirmedCount: 0, confirmedTotalSats: "0" },
    });
  });

  it("requires auth", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(401);
  });
});

describe("webhook deliveries (Part B)", () => {
  it("lists deliveries with query strings redacted", async () => {
    const invoice = await createViaApi({
      amountSats: "5000",
      webhookUrl: `${sink.url}?token=supersecret&x=1`,
    });
    h.mock.simulateIncomingPayment(invoice.address!, 5_000n);
    await h.poller.tick();
    await h.webhooks.sweep();
    await sink.waitFor(1);

    const res = await h.app.inject({
      method: "GET",
      url: `/api/invoices/${invoice.id}/webhook-deliveries`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const { deliveries } = res.json<{ deliveries: WebhookDeliveryDTO[] }>();
    expect(deliveries).toHaveLength(1);

    const d = deliveries[0]!;
    expect(d.status).toBe("delivered");
    expect(d.attempts).toBe(1);
    expect(d.url.startsWith(sink.url)).toBe(true);
    expect(d.createdAt).toBeTypeOf("number");
    expect(d.updatedAt).toBeTypeOf("number");
    expect(res.body).not.toContain("supersecret");
    expect(res.body).not.toContain("token=");
    // The signed body/signature are internal and never serialized.
    expect(d).not.toHaveProperty("body");
    expect(d).not.toHaveProperty("signature");

    const missing = await h.app.inject({
      method: "GET",
      url: "/api/invoices/inv_nope/webhook-deliveries",
      headers: authHeaders(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("retries a failed delivery; 409s for pending and delivered ones", async () => {
    sink.setResponseStatus(500);
    const invoice = await createViaApi({ amountSats: "5000", webhookUrl: sink.url });
    h.mock.simulateIncomingPayment(invoice.address!, 5_000n);
    await h.poller.tick();

    const [pendingDelivery] = h.repo.listWebhooksForInvoice(invoice.id!);
    expect(pendingDelivery?.status).toBe("pending");

    // Retrying a delivery that has not given up yet is a 409.
    const early = await h.app.inject({
      method: "POST",
      url: `/api/webhook-deliveries/${pendingDelivery!.id}/retry`,
      headers: authHeaders(),
      payload: {},
    });
    expect(early.statusCode).toBe(409);

    // Force it into the given-up state and retry against a healthy sink.
    h.repo.recordWebhookAttempt(pendingDelivery!.id, {
      status: "failed",
      attempts: 5,
      nextAttemptAt: Date.now(),
      statusCode: 500,
      error: "gave up",
    });
    sink.setResponseStatus(200);

    const retry = await h.app.inject({
      method: "POST",
      url: `/api/webhook-deliveries/${pendingDelivery!.id}/retry`,
      headers: authHeaders(),
      payload: {},
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json<{ delivery: WebhookDeliveryDTO }>().delivery.status).toBe("pending");

    await h.webhooks.sweep();
    expect(h.repo.getWebhook(pendingDelivery!.id)?.status).toBe("delivered");

    // Delivered -> another retry is a 409; unknown ids are 404.
    const again = await h.app.inject({
      method: "POST",
      url: `/api/webhook-deliveries/${pendingDelivery!.id}/retry`,
      headers: authHeaders(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    const missing = await h.app.inject({
      method: "POST",
      url: "/api/webhook-deliveries/whd_nope/retry",
      headers: authHeaders(),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("invoice list q filter (Part B)", () => {
  it("matches orderId exactly and invoice id by prefix", async () => {
    const one = await createViaApi({ amountSats: "1000", orderId: "ORD-1" });
    await createViaApi({ amountSats: "1000", orderId: "ORD-10" });
    await createViaApi({ amountSats: "1000" });

    const list = async (q: string) => {
      const res = await h.app.inject({
        method: "GET",
        url: `/api/invoices?q=${encodeURIComponent(q)}`,
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ invoices: Array<{ id: string; orderId: string | null }>; total: number }>();
    };

    // orderId is exact: "ORD-1" must not match "ORD-10".
    const exact = await list("ORD-1");
    expect(exact.total).toBe(1);
    expect(exact.invoices[0]?.orderId).toBe("ORD-1");

    // id prefix: the shared "inv_" prefix matches everything...
    expect((await list("inv_")).total).toBe(3);
    // ...a longer unique prefix matches exactly one...
    const prefix = await list(one.id!.slice(0, 12));
    expect(prefix.total).toBe(1);
    expect(prefix.invoices[0]?.id).toBe(one.id);
    // ...and LIKE wildcards are literals, not patterns.
    expect((await list("%")).total).toBe(0);
    expect((await list("inv_%")).total).toBe(0);

    // Composes with status filtering.
    const res = await h.app.inject({
      method: "GET",
      url: "/api/invoices?q=ORD-1&status=expired",
      headers: authHeaders(),
    });
    expect(res.json<{ total: number }>().total).toBe(0);
  });
});
