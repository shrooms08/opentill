import { describe, expect, it } from "vitest";
import { createAdapter, MockTachiAdapter, TachiRealAdapter } from "@opentill/adapter";

async function freshAdapter(commitLatencyMs = 20): Promise<MockTachiAdapter> {
  const adapter = new MockTachiAdapter({ mockCommitLatencyMs: commitLatencyMs });
  await adapter.init();
  return adapter;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createAdapter", () => {
  it("builds a mock adapter", () => {
    expect(createAdapter({ mode: "mock" })).toBeInstanceOf(MockTachiAdapter);
  });

  it("tachi mode needs tachi settings; with them it constructs the real adapter", () => {
    expect(() => createAdapter({ mode: "tachi" })).toThrow(/TACHI_MNEMONIC/);
    const real = createAdapter({
      mode: "tachi",
      tachi: {
        rpcUrl: "https://rpc-regtest.tachibtc.com",
        network: "regtest",
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        statePath: "/tmp/opentill-unused-state.json",
      },
    });
    expect(real).toBeInstanceOf(TachiRealAdapter);
  });
});

describe("MockTachiAdapter", () => {
  it("requires init before use", async () => {
    const adapter = new MockTachiAdapter();
    await expect(adapter.createReceiveAddress("x")).rejects.toThrow(/init\(\)/);
  });

  it("derives a unique mock1p address per call", async () => {
    const adapter = await freshAdapter();
    const addresses = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const { address } = await adapter.createReceiveAddress(`ref-${i}`);
      expect(address).toMatch(/^mock1p[a-z0-9]+$/);
      addresses.add(address);
    }
    expect(addresses.size).toBe(50);
  });

  it("only reports payments to watched addresses", async () => {
    const adapter = await freshAdapter();
    const watched = await adapter.createReceiveAddress("watched");
    const ignored = await adapter.createReceiveAddress("ignored");
    await adapter.watchAddress(watched.address);

    adapter.simulateIncomingPayment(watched.address, 1000n);
    adapter.simulateIncomingPayment(ignored.address, 5000n);

    const { payments } = await adapter.pollIncoming(null);
    expect(payments).toHaveLength(1);
    expect(payments[0]?.toAddress).toBe(watched.address);
  });

  it("moves a payment from seen to committed across polls", async () => {
    const adapter = await freshAdapter(30);
    const { address } = await adapter.createReceiveAddress("ref");
    await adapter.watchAddress(address);
    adapter.simulateIncomingPayment(address, 2500n);

    const first = await adapter.pollIncoming(null);
    expect(first.payments.map((p) => p.status)).toEqual(["seen"]);

    // Nothing new before the commit latency elapses.
    const second = await adapter.pollIncoming(first.nextCursor);
    expect(second.payments).toHaveLength(0);

    await sleep(50);
    const third = await adapter.pollIncoming(second.nextCursor);
    expect(third.payments).toHaveLength(1);
    expect(third.payments[0]?.status).toBe("committed");
    expect(third.payments[0]?.paymentId).toBe(first.payments[0]?.paymentId);

    // And the commit event is never replayed.
    const fourth = await adapter.pollIncoming(third.nextCursor);
    expect(fourth.payments).toHaveLength(0);
  });

  it("credits incoming payments and debits sends", async () => {
    const adapter = await freshAdapter();
    const { address } = await adapter.createReceiveAddress("ref");
    await adapter.watchAddress(address);
    adapter.simulateIncomingPayment(address, 10_000n);

    expect(await adapter.getBalance()).toEqual({ offchainSats: 10_000n, onchainSats: 0n });

    const { txId } = await adapter.send({ toAddress: "mock1pdest", amountSats: 4_000n, ref: "r" });
    expect(txId).toMatch(/^mocktx_[0-9a-f]{32}$/);
    expect((await adapter.getBalance()).offchainSats).toBe(6_000n);

    await expect(
      adapter.send({ toAddress: "mock1pdest", amountSats: 999_999n, ref: "r" }),
    ).rejects.toThrow(/InsufficientFunds|balance/);
  });

  it("stops reporting unwatched addresses", async () => {
    const adapter = await freshAdapter();
    const { address } = await adapter.createReceiveAddress("ref");
    await adapter.watchAddress(address);
    const seen = await adapter.pollIncoming(null);

    await adapter.unwatchAddress(address);
    adapter.simulateIncomingPayment(address, 1n);
    expect((await adapter.pollIncoming(seen.nextCursor)).payments).toHaveLength(0);
  });
});
