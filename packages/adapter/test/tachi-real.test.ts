import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InsufficientFundsError,
  TachiBroadcastError,
  TachiRealAdapter,
  vtxoIdFor,
  type TachiRealAdapterDeps,
} from "@opentill/adapter";

/**
 * Unit tests for the real adapter with an injected fake daemon client. The
 * fake speaks the exact response shapes recorded in docs/tachi-smoke-output.md.
 * No network. (Live coverage: `npm run smoke:tachi` / `npm run e2e:tachi`.)
 */

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TX_HASH = "c930934b465516319a00eacd96b47f7e9e30b26275ce5285c8f70fc7e1b8a789";

interface FakeVtxo { id: string; owner: string; amount: number; spent: boolean; height: number; script: string; locked: boolean }

function makeFake(opts: { chainId?: string; height?: number } = {}) {
  const state = {
    height: opts.height ?? 482_190,
    chainId: opts.chainId ?? "tachi-regtest-1",
    vtxos: new Map<string, FakeVtxo[]>(), // by address
    mempool: new Map<string, Array<{ tx_hash: string; vout: Array<{ owner: string; amount: number; script: string }> }>>(),
    balances: new Map<string, number>(),
    broadcasts: [] as string[],
    broadcastResult: { code: 0, log: "", hash: TX_HASH.toUpperCase() },
    l1TotalBtc: 0,
  };
  const client = {
    getHealth: async () => ({ status: "ok", validators: 1 }),
    getStatus: async () => ({ jsonrpc: "2.0", id: -1, result: { node_info: { network: state.chainId }, sync_info: { latest_block_height: String(state.height), catching_up: false } } }),
    getAddressVtxos: async (address: string, includeSpent = false) => {
      const all = state.vtxos.get(address) ?? [];
      const vtxos = includeSpent ? all : all.filter((v) => !v.spent);
      return { pubkey: "", count: vtxos.length, vtxos };
    },
    getMempoolByAddress: async (address: string) => ({ pubkey: "", count: 0, transactions: state.mempool.get(address) ?? [] }),
    getBalance: async (address: string) => ({ pubkey: "", balance_sat: state.balances.get(address) ?? 0 }),
    getFeeEstimate: async () => ({ min_fee_sat: 1, avg_fee_sat: 0, recommended_fee_sat: 1 }),
    broadcastTxSync: async (hex: string) => { state.broadcasts.push(hex); return { jsonrpc: "2.0", id: -1, result: { ...state.broadcastResult, data: "", codespace: "" } }; },
    bitcoinRPC: async () => ({ jsonrpc: "2.0", id: "t", error: null, result: { success: true, unspents: [], total_amount: state.l1TotalBtc } }),
  };
  return { state, client: client as unknown as NonNullable<TachiRealAdapterDeps["client"]> };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "opentill-tachi-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function adapter(fake: ReturnType<typeof makeFake>, extra: Partial<TachiRealAdapterDeps> = {}, statePath = join(dir, "state.json")) {
  return new TachiRealAdapter(
    { rpcUrl: "https://rpc-regtest.tachibtc.com", network: "regtest", mnemonic: MNEMONIC, statePath },
    { client: fake.client, nonce: async () => 0n, waitCommit: async () => ({ committed: true, code: 0, log: "" }), now: () => 1_700_000_000_000, ...extra },
  );
}

describe("TachiRealAdapter — boot", () => {
  it("refuses a daemon on the wrong chain", async () => {
    const fake = makeFake({ chainId: "tachi-signet-1" });
    await expect(adapter(fake).init()).rejects.toThrow(/TACHI_NETWORK=regtest.*tachi-signet-1/);
  });

  it("connects, seeds the till key, and logs network + height", async () => {
    const fake = makeFake({ height: 482_063 });
    const log = vi.fn();
    const a = new TachiRealAdapter({ rpcUrl: "https://x", network: "regtest", mnemonic: MNEMONIC, statePath: join(dir, "s.json"), log }, { client: fake.client });
    await a.init();
    expect(log).toHaveBeenCalledWith("tachi: connected", expect.objectContaining({ chainId: "tachi-regtest-1", height: 482_063 }));
    const till = a.keys()[0]!;
    expect(till.change).toBe(false);
    expect(till.index).toBe(0);
    expect(till.address).toMatch(/^bcrt1p/);
  });

  it("requires a mnemonic", () => {
    expect(() => new TachiRealAdapter({ rpcUrl: "https://x", network: "regtest", mnemonic: "", statePath: "x" })).toThrow(/TACHI_MNEMONIC/);
  });
});

describe("TachiRealAdapter — receive addresses", () => {
  it("hands out distinct change-chain keys and survives a restart via the state file", async () => {
    const fake = makeFake();
    const path = join(dir, "state.json");
    const a = adapter(fake, {}, path);
    await a.init();
    const { address: a1 } = await a.createReceiveAddress("inv-1");
    const { address: a2 } = await a.createReceiveAddress("inv-2");
    await a.watchAddress(a1);
    expect(a1).not.toBe(a2);
    expect(a1).toMatch(/^bcrt1p/);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted.nextInvoiceIndex).toBe(2);
    expect(persisted.watched).toEqual([a1]);
    expect(persisted.keys.filter((k: { change: boolean }) => k.change).map((k: { path: string }) => k.path)).toEqual(["m/84'/1'/0'/1/0", "m/84'/1'/0'/1/1"]);

    // "restart": a fresh instance on the same state file continues the sequence.
    const b = adapter(fake, {}, path);
    await b.init();
    const { address: a3 } = await b.createReceiveAddress("inv-3");
    expect(JSON.parse(readFileSync(path, "utf8")).nextInvoiceIndex).toBe(3);
    expect(a3).not.toBe(a1);
    expect(a3).not.toBe(a2);
    expect(b.keys().map((k) => k.address)).toContain(a1);
  });

  it("refuses to watch an address it does not own", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    await expect(a.watchAddress("bcrt1pcl6w03dkanxl3lqyvr8xupxvgvrrljs60cm74cjuh402cr23jmdshcu4al")).rejects.toThrow(/not one of our keys/);
  });
});

describe("TachiRealAdapter — pollIncoming", () => {
  it("maps committed VTXOs above the cursor and mempool credits to seen, with a safe watermark", async () => {
    const fake = makeFake({ height: 482_190 });
    const a = adapter(fake);
    await a.init();
    const { address } = await a.createReceiveAddress("inv");
    await a.watchAddress(address);
    const key = a.keys().find((k) => k.address === address)!;

    fake.state.vtxos.set(address, [
      { id: "5288714c8a0f45a70396f90d7a37a8e038a4cea1d103fab3c010f7924eb2d865", owner: key.xOnlyHex, amount: 10_000, spent: false, height: 482_190, script: "", locked: false },
      { id: "old", owner: key.xOnlyHex, amount: 5, spent: true, height: 482_000, script: "", locked: false },
    ]);
    fake.state.mempool.set(address, [{ tx_hash: "AB".repeat(32), vout: [{ owner: "someone-else", amount: 1, script: "" }, { owner: key.xOnlyHex, amount: 7_000, script: "" }] }]);

    const r = await a.pollIncoming("482100");
    expect(r.payments.map((p) => [p.paymentId, p.status, p.amountSats])).toEqual([
      [vtxoIdFor("ab".repeat(32), 1), "seen", 7_000n],
      ["5288714c8a0f45a70396f90d7a37a8e038a4cea1d103fab3c010f7924eb2d865", "committed", 10_000n],
    ]);
    expect(r.payments.every((p) => p.toAddress === address)).toBe(true);
    // watermark = height read at tick start − 1: a block landing mid-tick is never skipped
    expect(r.nextCursor).toBe("482189");

    // replay with cursor at the VTXO's height → committed one is filtered, seen still replays
    const again = await a.pollIncoming("482190");
    expect(again.payments.map((p) => p.status)).toEqual(["seen"]);
    expect(again.nextCursor).toBe("482190"); // never moves backwards
  });

  it("ignores unwatched keys", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    const { address } = await a.createReceiveAddress("inv");
    const key = a.keys().find((k) => k.address === address)!;
    fake.state.vtxos.set(address, [{ id: "x", owner: key.xOnlyHex, amount: 1, spent: false, height: 999_999, script: "", locked: false }]);
    expect((await a.pollIncoming(null)).payments).toEqual([]);
  });
});

describe("TachiRealAdapter — send (refund)", () => {
  async function fundedAdapter(fake: ReturnType<typeof makeFake>, extra: Partial<TachiRealAdapterDeps> = {}) {
    const a = adapter(fake, extra);
    await a.init();
    const till = a.keys()[0]!;
    fake.state.vtxos.set(till.address, [{ id: "d2134298ea5e820f71bb2d027c1025de4926f9edf24d61c76e62558471b5641d", owner: till.xOnlyHex, amount: 39_999, spent: false, height: 1, script: "", locked: false }]);
    return { a, till };
  }

  it("broadcasts a balanced transfer and returns the hash only after code 0 + commit", async () => {
    const fake = makeFake();
    const { a } = await fundedAdapter(fake);
    const { txId } = await a.send({ toAddress: "bcrt1pcl6w03dkanxl3lqyvr8xupxvgvrrljs60cm74cjuh402cr23jmdshcu4al", amountSats: 5_000n, ref: "inv" });
    expect(txId).toBe(TX_HASH);
    expect(fake.state.broadcasts).toHaveLength(1);
    expect(fake.state.broadcasts[0]).toMatch(/^0101/); // version 1, type TRANSFER, no 0x prefix
  });

  it("treats a resolved broadcast with code != 0 as failure (the SDK's #1 trap)", async () => {
    const fake = makeFake();
    fake.state.broadcastResult = { code: 8, log: "fee below minimum", hash: TX_HASH };
    const { a } = await fundedAdapter(fake);
    await expect(a.send({ toAddress: "bcrt1pcl6w03dkanxl3lqyvr8xupxvgvrrljs60cm74cjuh402cr23jmdshcu4al", amountSats: 5_000n, ref: "inv" })).rejects.toThrow(TachiBroadcastError);
    await expect(a.send({ toAddress: "bcrt1pcl6w03dkanxl3lqyvr8xupxvgvrrljs60cm74cjuh402cr23jmdshcu4al", amountSats: 5_000n, ref: "inv" })).rejects.toThrow(/fee below minimum/);
  });

  it("fails when the mempool accepted but the block did not commit", async () => {
    const fake = makeFake();
    const { a } = await fundedAdapter(fake, { waitCommit: async () => ({ committed: false, code: 3, log: "dropped at FinalizeBlock" }) });
    await expect(a.send({ toAddress: "bcrt1pcl6w03dkanxl3lqyvr8xupxvgvrrljs60cm74cjuh402cr23jmdshcu4al", amountSats: 5_000n, ref: "inv" })).rejects.toThrow(/dropped at FinalizeBlock/);
  });

  it("needs one key to cover amount + fee (no cross-key spends)", async () => {
    const fake = makeFake();
    const { a, till } = await fundedAdapter(fake);
    await expect(a.send({ toAddress: till.address, amountSats: 39_999n, ref: "x" })).rejects.toThrow(InsufficientFundsError);
    expect(fake.state.broadcasts).toHaveLength(0);
  });

  it("rejects non-taproot destinations", async () => {
    const fake = makeFake();
    const { a } = await fundedAdapter(fake);
    await expect(a.send({ toAddress: "bcrt1q4w8ufqp99jgze737mhp2kdlldvrzgggd7cxtf9", amountSats: 1_000n, ref: "x" })).rejects.toThrow();
  });
});

describe("TachiRealAdapter — balances + payouts", () => {
  it("sums ledger balances across keys and reads L1 via the proxy", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    const { address } = await a.createReceiveAddress("inv");
    fake.state.balances.set(a.keys()[0]!.address, 39_999);
    fake.state.balances.set(address, 5_000);
    fake.state.l1TotalBtc = 0.001;
    expect(await a.getBalance()).toEqual({ offchainSats: 44_999n, onchainSats: 100_000n });
  });

  it("reports payouts as failed/not-implemented instead of faking them", async () => {
    const fake = makeFake();
    const a = adapter(fake);
    await a.init();
    const coop = await a.initiatePayout({ kind: "cooperative", toAddress: "bc1q", amountSats: 1n });
    const exit = await a.initiatePayout({ kind: "exit", toAddress: "bc1q" });
    expect(coop.status).toBe("failed");
    expect(exit.status).toBe("failed");
    expect(coop.error).toMatch(/not implemented in real \(tachi\) mode/);
    expect(exit.error).toMatch(/vault/);
    expect(await a.pollPayouts()).toEqual([]);
  });
});
