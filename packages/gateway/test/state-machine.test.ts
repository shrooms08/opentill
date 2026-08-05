import { describe, expect, it } from "vitest";
import { INVOICE_STATUSES, type InvoiceStatus } from "@opentill/shared";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  INVOICE_TRANSITIONS,
  isTerminal,
  TERMINAL_STATUSES,
} from "../src/domain/state-machine";

const ALL: readonly InvoiceStatus[] = INVOICE_STATUSES;

const LEGAL: ReadonlyArray<[InvoiceStatus, InvoiceStatus]> = [
  ["pending", "paid"],
  ["pending", "underpaid"],
  ["pending", "expired"],
  ["paid", "confirmed"],
  ["confirmed", "refund_pending"],
  ["refund_pending", "refunded"],
  ["refund_pending", "confirmed"],
  // Gate 3: a top-up covering the shortfall un-sticks an underpaid invoice.
  ["underpaid", "paid"],
];

describe("invoice state machine", () => {
  it("declares exactly the expected legal transitions", () => {
    const declared = ALL.flatMap((from) => INVOICE_TRANSITIONS[from].map((to) => `${from}->${to}`));
    expect(declared.sort()).toEqual(LEGAL.map(([f, t]) => `${f}->${t}`).sort());
  });

  it.each(LEGAL)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
  const illegal = ALL.flatMap((from) => ALL.map((to) => [from, to] as const)).filter(
    ([from, to]) => !legalSet.has(`${from}->${to}`),
  );

  it.each(illegal)("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to, "inv_1")).toThrow(InvalidTransitionError);
  });

  it("covers every status in the map, including self-transitions being illegal", () => {
    expect(Object.keys(INVOICE_TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("identifies terminal states", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["expired", "refunded"]);
    expect(isTerminal("underpaid")).toBe(false);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
  });

  it("carries useful context on the error", () => {
    try {
      assertTransition("expired", "paid", "inv_abc");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.from).toBe("expired");
      expect(e.to).toBe("paid");
      expect(e.invoiceId).toBe("inv_abc");
      expect(e.message).toContain("inv_abc");
    }
  });
});
