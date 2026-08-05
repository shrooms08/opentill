import { EventEmitter } from "node:events";
import type { Invoice, InvoiceStatus, Payout, PayoutStatus } from "@opentill/shared";

/**
 * Everything observable about an invoice flows through here:
 * - `transition` — the status changed (state machine move).
 * - `updated`   — money-visible fields changed without a status move
 *                 (amountPaidSats top-ups on settled invoices, late payments).
 */
export type InvoiceEvent =
  | { kind: "transition"; invoice: Invoice; from: InvoiceStatus; to: InvoiceStatus; at: number }
  | { kind: "updated"; invoice: Invoice; at: number };

/** Channel key for subscribe-to-everything consumers (the webhook dispatcher). */
const ALL = Symbol("opentill:all-invoices");

/**
 * In-process pub/sub for invoice changes: one channel per invoice id plus a
 * firehose channel. Emission is synchronous, so a subscriber that writes to
 * the database (the webhook enqueuer) joins whatever SQLite transaction the
 * publisher currently holds — the Gate 1 "webhook row commits with the state
 * change" guarantee is preserved.
 */
export class InvoiceEventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    // Channels are per-invoice; SSE fan-in on a busy instance can legitimately
    // exceed the default 10-listener heuristic.
    this.#emitter.setMaxListeners(0);
  }

  publish(event: InvoiceEvent): void {
    this.#emitter.emit(ALL, event);
    this.#emitter.emit(event.invoice.id, event);
  }

  /** Listen to a single invoice's channel. Returns the unsubscribe function. */
  subscribe(invoiceId: string, listener: (event: InvoiceEvent) => void): () => void {
    this.#emitter.on(invoiceId, listener);
    return () => this.#emitter.off(invoiceId, listener);
  }

  /** Listen to every invoice (webhook dispatcher). Returns the unsubscribe function. */
  subscribeAll(listener: (event: InvoiceEvent) => void): () => void {
    this.#emitter.on(ALL, listener);
    return () => this.#emitter.off(ALL, listener);
  }

  /** How many listeners a single invoice channel has. Used by leak tests. */
  listenerCount(invoiceId: string): number {
    return this.#emitter.listenerCount(invoiceId);
  }
}

/**
 * Payout status change. `from` is null when the payout row is first recorded
 * (initiation), mirroring the invoice bus convention.
 */
export interface PayoutEvent {
  payout: Payout;
  from: PayoutStatus | null;
  to: PayoutStatus;
  at: number;
}

const ALL_PAYOUTS = Symbol("opentill:all-payouts");

/**
 * Separate bus from invoices — payout channels are keyed by payout id and
 * never share a channel with invoice traffic. Emission is synchronous for the
 * same reason as InvoiceEventBus: the webhook enqueuer must join the
 * publisher's SQLite transaction.
 */
export class PayoutEventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(0);
  }

  publish(event: PayoutEvent): void {
    this.#emitter.emit(ALL_PAYOUTS, event);
    this.#emitter.emit(event.payout.id, event);
  }

  subscribe(payoutId: string, listener: (event: PayoutEvent) => void): () => void {
    this.#emitter.on(payoutId, listener);
    return () => this.#emitter.off(payoutId, listener);
  }

  subscribeAll(listener: (event: PayoutEvent) => void): () => void {
    this.#emitter.on(ALL_PAYOUTS, listener);
    return () => this.#emitter.off(ALL_PAYOUTS, listener);
  }

  listenerCount(payoutId: string): number {
    return this.#emitter.listenerCount(payoutId);
  }
}
