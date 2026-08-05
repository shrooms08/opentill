import { describe, expect, it } from "vitest";
import {
  NotImplementedError,
  TachiIntegrationBlocked,
  TachiRealAdapter,
} from "@opentill/adapter";

/**
 * The Tachi adapter is a documentation scaffold: it never runs live (init
 * throws), but the three BLOCKED markers keyed to the open devnet questions
 * must stay wired. This test pins them so a future edit can't silently drop a
 * question.
 */
describe("TachiRealAdapter scaffold", () => {
  const adapter = new TachiRealAdapter({ mode: "tachi" });

  it("init() refuses and points at INTEGRATION.md", async () => {
    await expect(adapter.init()).rejects.toThrow(NotImplementedError);
    await expect(adapter.init()).rejects.toThrow(/INTEGRATION\.md/);
  });

  it("createReceiveAddress is blocked on Q3 (validator-set access)", async () => {
    await expect(adapter.createReceiveAddress("ref")).rejects.toMatchObject({
      name: "TachiIntegrationBlocked",
      questionId: "Q3-validator-access",
    });
  });

  it("pollIncoming is blocked on Q2 (receiver-side detection)", async () => {
    await expect(adapter.pollIncoming(null)).rejects.toBeInstanceOf(TachiIntegrationBlocked);
    await expect(adapter.pollIncoming(null)).rejects.toMatchObject({
      questionId: "Q2-receiver-detection",
    });
  });

  it("cooperative payout is blocked on Q1 (co-signing trigger)", async () => {
    await expect(
      adapter.initiatePayout({ kind: "cooperative", toAddress: "bc1q", amountSats: 1000n }),
    ).rejects.toMatchObject({ questionId: "Q1-cosign-trigger" });
  });

  it("every blocked error names INTEGRATION.md", async () => {
    await expect(adapter.createReceiveAddress("ref")).rejects.toThrow(/INTEGRATION\.md/);
  });
});
