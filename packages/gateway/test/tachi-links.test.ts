import { afterEach, describe, expect, it, vi } from "vitest";
import { PayoutUnsupportedError, PAYOUT_UNSUPPORTED_MESSAGE } from "@opentill/adapter";
import type { PublicInvoiceDTO } from "@opentill/shared";
import { loadConfig, resolveExplorer } from "../src/config";
import { authHeaders, makeHarness, type Harness } from "./helpers";

const base = { OPENTILL_API_KEY: "k", OPENTILL_WEBHOOK_SECRET: "s" };
const RPC = "https://rpc-regtest.tachibtc.com";
const explorer = {
  txUrl: `${RPC}/tachi_tx?hash={hash}`,
  addressUrl: `${RPC}/tachi_addressVtxos?address={address}&include_spent=true`,
};
const TX = "966110f46e8ff371562620e19cbd537fca6010b2dbb6dea88b88d720e0034f3e";

describe("explorer config", () => {
  it("defaults to the daemon's JSON endpoints in tachi mode, null in mock mode", () => {
    expect(resolveExplorer({}, RPC + "/")).toEqual(explorer);
    expect(resolveExplorer({}, null)).toBeNull();
    expect(loadConfig(base).explorer).toBeNull();
    const tachi = loadConfig({ ...base, ADAPTER_MODE: "tachi", TACHI_MNEMONIC: "x y z" });
    expect(tachi.explorer).toEqual(explorer);
  });

  it("honors TACHI_EXPLORER_*_URL overrides and validates their placeholders", () => {
    const env = { TACHI_EXPLORER_TX_URL: "https://ex.example/tx/{hash}", TACHI_EXPLORER_ADDRESS_URL: "https://ex.example/a/{address}" };
    expect(resolveExplorer(env, RPC)).toEqual({ txUrl: "https://ex.example/tx/{hash}", addressUrl: "https://ex.example/a/{address}" });
    expect(() => resolveExplorer({ TACHI_EXPLORER_TX_URL: "https://ex.example/tx" }, RPC)).toThrow(/\{hash\}/);
    expect(() => resolveExplorer({ TACHI_EXPLORER_ADDRESS_URL: "ftp://x/{address}" }, RPC)).toThrow(/http/);
  });

  it("reads OPENTILL_DEMO_URL", () => {
    expect(loadConfig({ ...base, OPENTILL_DEMO_URL: "https://demo.example/" }).demoUrl).toBe("https://demo.example");
    expect(loadConfig(base).demoUrl).toBeNull();
  });
});

describe("gateway exposure", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.destroy();
    h = undefined;
  });

  it("/healthz carries the explorer templates and demo URL (no secrets)", async () => {
    h = await makeHarness({ configOverrides: { explorer, demoUrl: "https://demo.example" } });
    const body = (await h.app.inject({ method: "GET", url: "/healthz" })).json();
    expect(body).toMatchObject({ explorer, demoUrl: "https://demo.example" });
    expect(JSON.stringify(body)).not.toMatch(/test_api_key|test_webhook_secret/);
  });

  it("stores the payment txid and surfaces it on the merchant and public views", async () => {
    h = await makeHarness({ configOverrides: { explorer } });
    const inv = (await h.app.inject({ method: "POST", url: "/api/invoices", headers: authHeaders(), payload: { amountSats: "2000" } })).json() as { id: string; address: string };

    const poll = vi.spyOn(h.mock, "pollIncoming");
    // Seen without a txid, then committed with one: the txid is filled in.
    poll.mockResolvedValueOnce({ payments: [{ paymentId: "v1", toAddress: inv.address, amountSats: 2000n, observedAt: Date.now(), status: "seen" }], nextCursor: "1" });
    await h.poller.tick();
    poll.mockResolvedValueOnce({ payments: [{ paymentId: "v1", toAddress: inv.address, amountSats: 2000n, observedAt: Date.now(), status: "committed", txId: TX }], nextCursor: "2" });
    await h.poller.tick();

    const merchant = (await h.app.inject({ method: "GET", url: `/api/invoices/${inv.id}`, headers: authHeaders() })).json() as { status: string; payments: Array<{ txId: string | null }> };
    expect(merchant.status).toBe("confirmed");
    expect(merchant.payments[0]!.txId).toBe(TX);

    const pub = (await h.app.inject({ method: "GET", url: `/pay/api/${inv.id}` })).json() as PublicInvoiceDTO;
    expect(pub.paymentTxIds).toEqual([TX]);
    expect(pub.explorer).toEqual(explorer);
  });

  it("public view has no explorer in mock mode", async () => {
    h = await makeHarness();
    const inv = (await h.app.inject({ method: "POST", url: "/api/invoices", headers: authHeaders(), payload: { amountSats: "2000" } })).json() as { id: string };
    const pub = (await h.app.inject({ method: "GET", url: `/pay/api/${inv.id}` })).json() as PublicInvoiceDTO;
    expect(pub.explorer).toBeNull();
    expect(pub.paymentTxIds).toEqual([]);
  });

  it("/api/balance reports the till address (null for the mock adapter)", async () => {
    h = await makeHarness();
    const body = (await h.app.inject({ method: "GET", url: "/api/balance", headers: authHeaders() })).json();
    expect(body).toHaveProperty("tillAddress", null);
    (h.mock as unknown as { getTillAddress: () => string }).getTillAddress = () => "bcrt1ptill";
    expect((await h.app.inject({ method: "GET", url: "/api/balance", headers: authHeaders() })).json()).toHaveProperty("tillAddress", "bcrt1ptill");
  });

  it("answers 501 with the exit-support message when the adapter cannot pay out, recording nothing", async () => {
    h = await makeHarness();
    vi.spyOn(h.mock, "initiatePayout").mockRejectedValue(new PayoutUnsupportedError());
    const res = await h.app.inject({ method: "POST", url: "/api/payouts", headers: authHeaders(), payload: { kind: "exit", toAddress: "bc1qcold" } });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "payout_unsupported", message: PAYOUT_UNSUPPORTED_MESSAGE });
    expect(PAYOUT_UNSUPPORTED_MESSAGE).toMatch(/does not expose yet/);
    expect(PAYOUT_UNSUPPORTED_MESSAGE).not.toMatch(/SDK builder/);
    const list = (await h.app.inject({ method: "GET", url: "/api/payouts", headers: authHeaders() })).json() as { total: number };
    expect(list.total).toBe(0);
  });
});
