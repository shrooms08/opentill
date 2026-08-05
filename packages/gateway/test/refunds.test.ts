import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../src/domain/state-machine";
import { refundInvoice } from "../src/domain/invoices";
import { authHeaders, makeHarness, startWebhookSink, type Harness, type WebhookSink } from "./helpers";

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

/** Drives an invoice all the way to `confirmed`. */
async function confirmedInvoice(amountSats = "20000"): Promise<Record<string, string>> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: authHeaders(),
    payload: { amountSats, webhookUrl: sink.url },
  });
  const invoice = res.json<Record<string, string>>();
  h.mock.simulateIncomingPayment(invoice.address!, BigInt(amountSats));
  await h.poller.tick();
  h.mock.forceCommitAll();
  await h.poller.tick();
  expect(h.repo.getInvoice(invoice.id!)?.status).toBe("confirmed");
  return invoice;
}

describe("refunds", () => {
  it("refunds a confirmed invoice and records the txId", async () => {
    const invoice = await confirmedInvoice("20000");

    const res = await h.app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/refund`,
      headers: authHeaders(),
      payload: { toAddress: "mock1pcustomerrefundaddr" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ txId: string; invoice: Record<string, string> }>();
    expect(body.txId).toMatch(/^mocktx_/);
    expect(body.invoice.status).toBe("refunded");
    expect(body.invoice.refundAddress).toBe("mock1pcustomerrefundaddr");
    expect(body.invoice.refundTxId).toBe(body.txId);
    expect(body.invoice.refundError).toBeNull();

    // The full amount paid left the mock ledger.
    expect((await h.adapter.getBalance()).offchainSats).toBe(0n);

    const hooks = await sink.waitFor(4);
    expect(hooks.map((w) => w.parsed.status)).toEqual([
      "paid",
      "confirmed",
      "refund_pending",
      "refunded",
    ]);
  });

  it("refunds the amount actually paid, not the amount invoiced", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: authHeaders(),
      payload: { amountSats: "10000" },
    });
    const invoice = res.json<Record<string, string>>();
    h.mock.simulateIncomingPayment(invoice.address!, 17_000n);
    await h.poller.tick();
    h.mock.forceCommitAll();
    await h.poller.tick();

    await h.app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/refund`,
      headers: authHeaders(),
      payload: { toAddress: "mock1pdest" },
    });

    expect((await h.adapter.getBalance()).offchainSats).toBe(0n);
    expect(h.repo.getInvoice(invoice.id!)?.status).toBe("refunded");
  });

  it("rejects a refund from an illegal state with 409", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: authHeaders(),
      payload: { amountSats: "5000" },
    });
    const invoice = res.json<Record<string, string>>();

    const refund = await h.app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/refund`,
      headers: authHeaders(),
      payload: { toAddress: "mock1pdest" },
    });

    expect(refund.statusCode).toBe(409);
    expect(refund.json<{ error: string; from: string }>()).toMatchObject({
      error: "invalid_state",
      from: "pending",
      to: "refund_pending",
    });
    expect(h.repo.getInvoice(invoice.id!)?.status).toBe("pending");
  });

  it("throws InvalidTransitionError at the service layer too", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: authHeaders(),
      payload: { amountSats: "5000" },
    });
    const invoice = res.json<Record<string, string>>();
    await expect(refundInvoice(h.ctx, invoice.id!, "mock1pdest")).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it("reverts to confirmed and records the error when the send fails", async () => {
    const invoice = await confirmedInvoice("20000");

    // Drain the mock ledger so the refund send cannot cover the amount.
    await h.adapter.send({ toAddress: "mock1pelsewhere", amountSats: 20_000n, ref: "drain" });

    const res = await h.app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/refund`,
      headers: authHeaders(),
      payload: { toAddress: "mock1pdest" },
    });

    expect(res.statusCode).toBe(502);
    const after = h.repo.getInvoice(invoice.id!);
    expect(after?.status).toBe("confirmed");
    expect(after?.refundTxId).toBeNull();
    expect(after?.refundError).toMatch(/balance/);

    const hooks = await sink.waitFor(4);
    expect(hooks.map((w) => w.parsed.status)).toEqual([
      "paid",
      "confirmed",
      "refund_pending",
      "confirmed",
    ]);
  });

  it("404s an unknown invoice", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/invoices/inv_missing/refund",
      headers: authHeaders(),
      payload: { toAddress: "mock1pdest" },
    });
    expect(res.statusCode).toBe(404);
  });
});
