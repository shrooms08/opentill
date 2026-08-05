import type { InvoiceStatus } from "@opentill/shared";

/**
 * The ONE place invoice transitions are defined. Everything that mutates
 * invoice.status must route through `assertTransition`.
 *
 *   pending ──► paid ──► confirmed ──► refund_pending ──► refunded
 *      │          ▲                          │
 *      ├──► underpaid (top-up can cover)     └──► confirmed (send failed)
 *      └──► expired   (terminal)
 *
 * underpaid -> paid (Gate 3): a top-up credit that brings cumulative
 * amountPaidSats to >= amountSats un-sticks the invoice; expired stays
 * terminal — late money is recorded but never credited.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> =
  Object.freeze({
    pending: ["paid", "underpaid", "expired"],
    paid: ["confirmed"],
    confirmed: ["refund_pending"],
    refund_pending: ["refunded", "confirmed"],
    expired: [],
    underpaid: ["paid"],
    refunded: [],
  } as const);

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly InvoiceStatus[] = Object.freeze(
  (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).filter(
    (s) => INVOICE_TRANSITIONS[s].length === 0,
  ),
);

export class InvalidTransitionError extends Error {
  readonly from: InvoiceStatus;
  readonly to: InvoiceStatus;
  readonly invoiceId: string | undefined;

  constructor(from: InvoiceStatus, to: InvoiceStatus, invoiceId?: string) {
    super(
      `illegal invoice transition ${from} -> ${to}` +
        (invoiceId ? ` (invoice ${invoiceId})` : "") +
        `; legal targets from ${from}: [${INVOICE_TRANSITIONS[from].join(", ") || "none"}]`,
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.invoiceId = invoiceId;
  }
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

/** Throws `InvalidTransitionError` unless `from -> to` is legal. */
export function assertTransition(from: InvoiceStatus, to: InvoiceStatus, invoiceId?: string): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to, invoiceId);
  }
}

export function isTerminal(status: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[status].length === 0;
}
