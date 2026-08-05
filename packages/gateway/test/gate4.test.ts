import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PayoutDTO, PayoutWebhookPayload } from "@opentill/shared";
import { verifySignature } from "../src/webhooks";
import {
  authHeaders,
  makeHarness,
  startWebhookSink,
  WEBHOOK_SECRET,
  type Harness,
  type WebhookSink,
} from "./helpers";

let h: Harness;
let sink: WebhookSink;

beforeEach(async () => {
  sink = await startWebhookSink();
  h = await makeHarness({ configOverrides: { payoutWebhookUrl: sink.url } });
});

afterEach(async () => {
  await h.destroy();
  await sink.close();
});

/** Fund the mock's off-chain balance through a real confirmed invoice. */
async function fundViaInvoice(amountSats: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: authHeaders(),
    payload: { amountSats },
  });
  expect(res.statusCode).toBe(201);
  const invoice = res.json<{ id: string; address: string }>();
  h.mock.simulateIncomingPayment(invoice.address, BigInt(amountSats));
  await h.poller.tick();
  h.mock.forceCommitAll();
  await h.poller.tick();
  return invoice.id;
}

async function getBalance(): Promise<{ offchainSats: string; onchainSats: string }> {
  const res = await h.app.inject({ method: "GET", url: "/api/balance", headers: authHeaders() });
  return res.json();
}

async function postPayout(body: Record<string, unknown>) {
  return h.app.inject({ method: "POST", url: "/api/payouts", headers: authHeaders(), payload: body });
}

async function getPayout(id: string): Promise<PayoutDTO> {
  const res = await h.app.inject({
    method: "GET",
    url: `/api/payouts/${id}`,
    headers: authHeaders(),
  });
  expect(res.statusCode).toBe(200);
  return res.json<PayoutDTO>();
}

describe("cooperative payout lifecycle", () => {
  it("initiated -> broadcasting -> settled, debiting then crediting on-chain", async () => {
    await fundViaInvoice("100000");
    expect(await getBalance()).toEqual({ offchainSats: "100000", onchainSats: "0" });

    const created = await postPayout({
      kind: "cooperative",
      toAddress: "bc1qmerchantcold",
      amountSats: "30000",
    });
    expect(created.statusCode).toBe(201);
    const payout = created.json<PayoutDTO>();
    expect(payout.status).toBe("initiated");
    expect(payout.kind).toBe("cooperative");
    expect((await getBalance()).offchainSats).toBe("70000");

    h.mock.advanceBlocks(1);
    await h.payoutPoller.tick();
    expect((await getPayout(payout.id)).status).toBe("broadcasting");
    expect((await getPayout(payout.id)).txId).toMatch(/^mocktx_/);

    h.mock.advanceBlocks(1);
    await h.payoutPoller.tick();
    const settled = await getPayout(payout.id);
    expect(settled.status).toBe("settled");
    expect(settled.settledAt).toBeTypeOf("number");
    expect(await getBalance()).toEqual({ offchainSats: "70000", onchainSats: "30000" });

    const list = await h.app.inject({ method: "GET", url: "/api/payouts", headers: authHeaders() });
    expect(list.json<{ total: number; payouts: PayoutDTO[] }>().total).toBe(1);
  });

  it("insufficient balance fails without debiting and records the failed payout", async () => {
    await fundViaInvoice("1000");
    const res = await postPayout({
      kind: "cooperative",
      toAddress: "bc1qmerchant",
      amountSats: "5000",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; payout: PayoutDTO }>();
    expect(body.error).toBe("payout_failed");
    expect(body.payout.status).toBe("failed");
    expect(body.payout.error).toMatch(/balance/);
    expect((await getBalance()).offchainSats).toBe("1000");
    expect((await getPayout(body.payout.id)).status).toBe("failed");
  });

  it("validates the kind/amount pairing", async () => {
    const missing = await postPayout({ kind: "cooperative", toAddress: "bc1qmerchant" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: string }>().error).toBe("validation_error");

    const forbidden = await postPayout({
      kind: "exit",
      toAddress: "bc1qmerchant",
      amountSats: "1000",
    });
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.body).toMatch(/sweeps the entire balance/);
  });
});

describe("unilateral exit", () => {
  it("runs the timelock, blocks refunds and other payouts with 409s, then settles", async () => {
    const invoiceId = await fundViaInvoice("50000");
    await fundViaInvoice("30000");
    expect(await getBalance()).toEqual({ offchainSats: "80000", onchainSats: "0" });

    const created = await postPayout({ kind: "exit", toAddress: "bc1qsovereign" });
    expect(created.statusCode).toBe(201);
    const exit = created.json<PayoutDTO>();
    expect(exit.status).toBe("initiated");
    expect(exit.amountSats).toBe("80000");
    expect(exit.timelockBlocksRemaining).toBe(12);
    expect((await getBalance()).offchainSats).toBe("0");

    h.mock.advanceBlocks(1);
    await h.payoutPoller.tick();
    expect((await getPayout(exit.id)).status).toBe("waiting_timelock");

    // Refund while the vault is being swept: 409, and the invoice reverts
    // refund_pending -> confirmed with the error recorded.
    const refund = await h.app.inject({
      method: "POST",
      url: `/api/invoices/${invoiceId}/refund`,
      headers: authHeaders(),
      payload: { toAddress: "mock1pcustomer" },
    });
    expect(refund.statusCode).toBe(409);
    const refundBody = refund.json<{ error: string; invoice: { status: string } }>();
    expect(refundBody.error).toBe("exit_pending");
    expect(refundBody.invoice.status).toBe("confirmed");
    const reverted = h.repo.getInvoice(invoiceId)!;
    expect(reverted.status).toBe("confirmed");
    expect(reverted.refundError).toMatch(/exit is sweeping the vault/);

    // Second exit and cooperative payout: both 409 exit_pending.
    const secondExit = await postPayout({ kind: "exit", toAddress: "bc1qother" });
    expect(secondExit.statusCode).toBe(409);
    expect(secondExit.json<{ error: string }>().error).toBe("exit_pending");

    const coop = await postPayout({
      kind: "cooperative",
      toAddress: "bc1qother",
      amountSats: "1000",
    });
    expect(coop.statusCode).toBe(409);
    expect(coop.json<{ error: string }>().error).toBe("exit_pending");

    // Timelock runs out (advanceBlocks -> no sleeping).
    h.mock.advanceBlocks(12);
    await h.payoutPoller.tick();
    const settled = await getPayout(exit.id);
    expect(settled.status).toBe("settled");
    expect(settled.timelockBlocksRemaining).toBeNull();
    expect(await getBalance()).toEqual({ offchainSats: "0", onchainSats: "80000" });

    // Spending unlocks again: a new cooperative payout is accepted (until it
    // hits the now-empty balance, which is a clean adapter-side failure).
    const after = await postPayout({
      kind: "cooperative",
      toAddress: "bc1qother",
      amountSats: "1000",
    });
    expect(after.statusCode).toBe(400);
    expect(after.json<{ error: string }>().error).toBe("payout_failed");
  });
});

describe("payout poller idempotency and webhooks", () => {
  it("re-polling an unchanged status writes nothing and fires no duplicate webhook", async () => {
    await fundViaInvoice("10000");
    const created = await postPayout({
      kind: "cooperative",
      toAddress: "bc1qmerchant",
      amountSats: "5000",
    });
    const payout = created.json<PayoutDTO>();

    // Initiation recorded the row and enqueued the `initiated` webhook.
    expect(h.repo.listWebhooksForPayout(payout.id)).toHaveLength(1);

    // Same snapshot, twice, with no block advance: no new rows, no new hooks.
    await h.payoutPoller.tick();
    await h.payoutPoller.tick();
    expect(h.repo.countPayouts()).toBe(1);
    expect(h.repo.listWebhooksForPayout(payout.id)).toHaveLength(1);

    const timelessUpdate = await getPayout(payout.id);
    expect(timelessUpdate.status).toBe("initiated");
  });

  it("payout webhooks use the shared HMAC + delivery machinery", async () => {
    await fundViaInvoice("10000");
    const created = await postPayout({
      kind: "cooperative",
      toAddress: "bc1qmerchant",
      amountSats: "5000",
    });
    const payout = created.json<PayoutDTO>();

    h.mock.advanceBlocks(1);
    await h.payoutPoller.tick();
    h.mock.advanceBlocks(1);
    await h.payoutPoller.tick();
    await h.webhooks.sweep();
    const hooks = await sink.waitFor(3); // initiated, broadcasting, settled

    const statuses = hooks.map((w) => (w.parsed as unknown as PayoutWebhookPayload).status);
    expect(statuses).toEqual(["initiated", "broadcasting", "settled"]);
    for (const hook of hooks) {
      expect(verifySignature(hook.body, hook.signature, WEBHOOK_SECRET)).toBe(true);
      const parsed = hook.parsed as unknown as PayoutWebhookPayload;
      expect(parsed.payoutId).toBe(payout.id);
      expect(parsed.kind).toBe("cooperative");
      expect(parsed.amountSats).toBe("5000");
    }
    expect(hooks[2]?.parsed).toMatchObject({ previousStatus: "broadcasting", status: "settled" });

    // Rows live in the same webhook_deliveries table, tied to the payout.
    const rows = h.repo.listWebhooksForPayout(payout.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.payoutId).toBe(payout.id);
      expect(row.invoiceId).toBeNull();
      expect(row.status).toBe("delivered");
    }
  });

  it("fires no payout webhooks when the URL is not configured", async () => {
    await h.destroy();
    h = await makeHarness(); // default: payoutWebhookUrl null
    await fundViaInvoice("10000");
    const created = await postPayout({
      kind: "cooperative",
      toAddress: "bc1qmerchant",
      amountSats: "5000",
    });
    expect(created.statusCode).toBe(201);
    expect(h.repo.listWebhooksForPayout(created.json<PayoutDTO>().id)).toHaveLength(0);
  });
});
