import { describe, expect, it } from "vitest";
import { ExitPendingError, MockTachiAdapter } from "@opentill/adapter";

async function fundedAdapter(sats: bigint): Promise<MockTachiAdapter> {
  const adapter = new MockTachiAdapter({ mockOpeningBalanceSats: sats });
  await adapter.init();
  return adapter;
}

describe("cooperative payouts", () => {
  it("walks initiated -> broadcasting -> settled and moves the balance on-chain", async () => {
    const adapter = await fundedAdapter(100_000n);

    const payout = await adapter.initiatePayout({
      kind: "cooperative",
      toAddress: "bc1qmerchant",
      amountSats: 30_000n,
    });
    expect(payout.status).toBe("initiated");
    expect(payout.amountSats).toBe(30_000n);
    // Debited immediately.
    expect((await adapter.getBalance()).offchainSats).toBe(70_000n);
    expect((await adapter.getBalance()).onchainSats).toBe(0n);

    adapter.advanceBlocks(1);
    let [polled] = await adapter.pollPayouts();
    expect(polled?.status).toBe("broadcasting");
    expect(polled?.txId).toMatch(/^mocktx_/);

    adapter.advanceBlocks(1);
    [polled] = await adapter.pollPayouts();
    expect(polled?.status).toBe("settled");
    expect((await adapter.getBalance()).onchainSats).toBe(30_000n);
    expect((await adapter.getBalance()).offchainSats).toBe(70_000n);

    // Terminal payouts are reported exactly once.
    expect(await adapter.pollPayouts()).toHaveLength(0);
  });

  it("fails without debiting when the amount exceeds the balance", async () => {
    const adapter = await fundedAdapter(1_000n);
    const payout = await adapter.initiatePayout({
      kind: "cooperative",
      toAddress: "bc1qmerchant",
      amountSats: 5_000n,
    });
    expect(payout.status).toBe("failed");
    expect(payout.error).toMatch(/balance/);
    expect((await adapter.getBalance()).offchainSats).toBe(1_000n);
  });

  it("fails cleanly on an empty address or missing amount", async () => {
    const adapter = await fundedAdapter(1_000n);
    expect(
      (await adapter.initiatePayout({ kind: "cooperative", toAddress: "  ", amountSats: 10n }))
        .status,
    ).toBe("failed");
    expect(
      (await adapter.initiatePayout({ kind: "cooperative", toAddress: "bc1q" })).status,
    ).toBe("failed");
    expect((await adapter.getBalance()).offchainSats).toBe(1_000n);
  });
});

describe("unilateral exit", () => {
  it("sweeps the whole balance through the timelock without sleeping", async () => {
    const adapter = await fundedAdapter(250_000n);

    const exit = await adapter.initiatePayout({ kind: "exit", toAddress: "bc1qcoldstorage" });
    expect(exit.status).toBe("initiated");
    expect(exit.amountSats).toBe(250_000n);
    expect(exit.timelockBlocksRemaining).toBe(12);
    // Whole balance committed to the exit tx at initiation.
    expect((await adapter.getBalance()).offchainSats).toBe(0n);

    adapter.advanceBlocks(1);
    let [polled] = await adapter.pollPayouts();
    expect(polled?.status).toBe("waiting_timelock");
    expect(polled?.timelockBlocksRemaining).toBe(12);
    expect(polled?.txId).toMatch(/^mocktx_/);

    adapter.advanceBlocks(5);
    [polled] = await adapter.pollPayouts();
    expect(polled?.status).toBe("waiting_timelock");
    expect(polled?.timelockBlocksRemaining).toBe(7);

    adapter.advanceBlocks(7);
    [polled] = await adapter.pollPayouts();
    expect(polled?.status).toBe("settled");
    expect(polled?.timelockBlocksRemaining).toBeUndefined();

    const balance = await adapter.getBalance();
    expect(balance.offchainSats).toBe(0n);
    expect(balance.onchainSats).toBe(250_000n);
  });

  it("blocks sends, cooperative payouts, and second exits while pending", async () => {
    const adapter = await fundedAdapter(50_000n);
    await adapter.initiatePayout({ kind: "exit", toAddress: "bc1qcold" });

    await expect(
      adapter.send({ toAddress: "mock1pcustomer", amountSats: 1_000n, ref: "refund" }),
    ).rejects.toThrow(ExitPendingError);

    const coop = await adapter.initiatePayout({
      kind: "cooperative",
      toAddress: "bc1qother",
      amountSats: 1_000n,
    });
    expect(coop.status).toBe("failed");
    expect(coop.error).toMatch(/exit is sweeping/);

    const second = await adapter.initiatePayout({ kind: "exit", toAddress: "bc1qother" });
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/already pending/);

    // Once settled, spending works again.
    adapter.advanceBlocks(13);
    await adapter.pollPayouts();
    const { address } = await adapter.createReceiveAddress("new");
    await adapter.watchAddress(address);
    adapter.simulateIncomingPayment(address, 5_000n);
    await expect(
      adapter.send({ toAddress: "mock1pcustomer", amountSats: 1_000n, ref: "refund" }),
    ).resolves.toMatchObject({ txId: expect.stringMatching(/^mocktx_/) });
  });

  it("refuses to exit an empty vault", async () => {
    const adapter = await fundedAdapter(0n);
    const exit = await adapter.initiatePayout({ kind: "exit", toAddress: "bc1qcold" });
    expect(exit.status).toBe("failed");
    expect(exit.error).toMatch(/zero/);
  });
});
