import {
  DEFAULT_EXPIRY_SECONDS,
  type CreateInvoiceBody,
  type Invoice,
  type InvoiceStatus,
} from "@opentill/shared";
import { ExitPendingError, type IncomingPayment, type TachiAdapter } from "@opentill/adapter";
import type { Repo } from "../db/repo";
import type { InvoiceEventBus, PayoutEventBus } from "../events";
import { assertTransition } from "./state-machine";

export interface ServiceContext {
  repo: Repo;
  adapter: TachiAdapter;
  events: InvoiceEventBus;
  payoutEvents: PayoutEventBus;
}

export class InvoiceNotFoundError extends Error {
  constructor(id: string) {
    super(`invoice ${id} not found`);
    this.name = "InvoiceNotFoundError";
  }
}

type InvoicePatch = Parameters<Repo["updateInvoice"]>[1];

/**
 * The only sanctioned way to change invoice.status. Validates against the
 * transition map, persists, and publishes the change on the event bus — all
 * synchronously on the caller's connection, so subscribers that write (the
 * webhook enqueuer) join whatever transaction is open.
 */
export function transitionInvoice(
  ctx: ServiceContext,
  invoice: Invoice,
  to: InvoiceStatus,
  patch: Omit<InvoicePatch, "status"> = {},
  now: number = Date.now(),
): Invoice {
  assertTransition(invoice.status, to, invoice.id);
  const stamped: InvoicePatch = { ...patch, status: to };
  // First arrival in `confirmed` is stamped; refund_pending -> confirmed
  // reverts keep the original time.
  if (to === "confirmed" && invoice.confirmedAt === null) stamped.confirmedAt = now;
  ctx.repo.updateInvoice(invoice.id, stamped, now);

  const updated = ctx.repo.getInvoice(invoice.id);
  if (!updated) throw new InvoiceNotFoundError(invoice.id);

  ctx.events.publish({ kind: "transition", invoice: updated, from: invoice.status, to, at: now });
  return updated;
}

/** Publish a money-visible change that did not move the state machine. */
function publishUpdated(ctx: ServiceContext, invoiceId: string, now: number): void {
  const updated = ctx.repo.getInvoice(invoiceId);
  if (updated) ctx.events.publish({ kind: "updated", invoice: updated, at: now });
}

export async function createInvoice(
  ctx: ServiceContext,
  body: CreateInvoiceBody,
  now: number = Date.now(),
): Promise<Invoice> {
  const expiresInSeconds = body.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  const { address } = await ctx.adapter.createReceiveAddress(body.orderId ?? "invoice");
  await ctx.adapter.watchAddress(address);

  return ctx.repo.insertInvoice(
    {
      amountSats: BigInt(body.amountSats),
      address,
      memo: body.memo ?? null,
      orderId: body.orderId ?? null,
      webhookUrl: body.webhookUrl ?? null,
      returnUrl: body.returnUrl ?? null,
      expiresAt: now + expiresInSeconds * 1000,
    },
    now,
  );
}

/**
 * Fold one settlement event into the ledger. Idempotent: replaying an event
 * whose (paymentId, status) we have already recorded does nothing.
 *
 * Must be called inside a transaction — see `Poller.tick`.
 */
export function applyIncomingPayment(
  ctx: ServiceContext,
  p: IncomingPayment,
  now: number = Date.now(),
): void {
  const existing = ctx.repo.getPaymentByPaymentId(p.paymentId);
  const invoice = ctx.repo.getInvoiceByAddress(p.toAddress);

  if (existing) {
    // The only forward move is seen -> committed. Anything else is a replay.
    if (!(existing.status === "seen" && p.status === "committed")) return;
    ctx.repo.updatePaymentStatus(p.paymentId, "committed", now);
  } else {
    const late =
      invoice !== null && (p.observedAt > invoice.expiresAt || invoice.status === "expired");

    ctx.repo.insertPayment(
      {
        paymentId: p.paymentId,
        invoiceId: invoice?.id ?? null,
        address: p.toAddress,
        amountSats: p.amountSats,
        status: p.status,
        latePayment: late,
        observedAt: p.observedAt,
      },
      now,
    );

    // Late money is recorded but never credited: the invoice is already dead
    // and nothing is owed against it. It still changes the public view
    // (latePayment flag), so live checkout pages hear about it.
    if (invoice && !late) creditPayment(ctx, invoice, p.amountSats, now);
    else if (invoice && late) publishUpdated(ctx, invoice.id, now);
  }

  if (invoice) maybeConfirm(ctx, invoice.id, p.status, now);
}

/**
 * Commit rule (Gate 3): an invoice moves paid -> confirmed only when EVERY
 * credited payment — every non-late payment counted into amountPaidSats — has
 * reached `committed`, not just the one whose commit we are processing. With a
 * single covering payment this is Gate 1 behavior unchanged; when an underpaid
 * invoice was topped up across several payments, the merchant's "confirmed"
 * must mean all of that money settled, so the strictest simple rule wins.
 */
function maybeConfirm(
  ctx: ServiceContext,
  invoiceId: string,
  eventStatus: IncomingPayment["status"],
  now: number,
): void {
  if (eventStatus !== "committed") return;
  const current = ctx.repo.getInvoice(invoiceId);
  if (current?.status === "paid" && ctx.repo.allCreditedPaymentsCommitted(invoiceId)) {
    transitionInvoice(ctx, current, "confirmed", {}, now);
  }
}

function creditPayment(ctx: ServiceContext, invoice: Invoice, amount: bigint, now: number): void {
  const total = invoice.amountPaidSats + amount;

  if (invoice.status === "pending" || invoice.status === "underpaid") {
    if (total >= invoice.amountSats) {
      // Covers the invoice — from pending (single payment) or from underpaid
      // (Gate 3 top-up). paid -> confirmed then waits on the commit rule above.
      transitionInvoice(ctx, invoice, "paid", { amountPaidSats: total, shortfallSats: null }, now);
    } else if (invoice.status === "pending") {
      transitionInvoice(
        ctx,
        invoice,
        "underpaid",
        { amountPaidSats: total, shortfallSats: invoice.amountSats - total },
        now,
      );
    } else {
      // Top-up that is still short: the shortfall shrinks, the state stays.
      ctx.repo.updateInvoice(
        invoice.id,
        { amountPaidSats: total, shortfallSats: invoice.amountSats - total },
        now,
      );
      publishUpdated(ctx, invoice.id, now);
    }
    return;
  }

  // Overpayment / top-up on an already-moved invoice (paid, confirmed, ...):
  // money is tracked, the state machine stays put.
  ctx.repo.updateInvoice(invoice.id, { amountPaidSats: total }, now);
  publishUpdated(ctx, invoice.id, now);
}

/** Expire every pending invoice past its deadline. Returns how many moved. */
export function expireDueInvoices(ctx: ServiceContext, now: number = Date.now()): number {
  const due = ctx.repo.findExpirable(now);
  if (due.length === 0) return 0;

  ctx.repo.db.transaction(() => {
    for (const invoice of due) {
      transitionInvoice(ctx, invoice, "expired", {}, now);
    }
  })();

  return due.length;
}

export interface RefundResult {
  invoice: Invoice;
  txId: string | null;
  error: string | null;
  /** True when the send was rejected because a unilateral exit is sweeping the vault. */
  exitPending: boolean;
}

/**
 * confirmed -> refund_pending -> refunded, reverting to confirmed if the
 * settlement layer rejects the send. The send happens outside a transaction
 * (it is network IO); refund_pending is committed first so a crash mid-send is
 * visible rather than silent.
 */
export async function refundInvoice(
  ctx: ServiceContext,
  invoiceId: string,
  toAddress: string,
  now: number = Date.now(),
): Promise<RefundResult> {
  const invoice = ctx.repo.getInvoice(invoiceId);
  if (!invoice) throw new InvoiceNotFoundError(invoiceId);

  // Throws InvalidTransitionError for anything but `confirmed`.
  const pending = ctx.repo.db.transaction(() =>
    transitionInvoice(
      ctx,
      invoice,
      "refund_pending",
      { refundAddress: toAddress, refundError: null },
      now,
    ),
  )();

  try {
    const { txId } = await ctx.adapter.send({
      toAddress,
      amountSats: pending.amountPaidSats,
      ref: pending.id,
    });
    const done = ctx.repo.db.transaction(() =>
      transitionInvoice(ctx, pending, "refunded", { refundTxId: txId }, Date.now()),
    )();
    return { invoice: done, txId, error: null, exitPending: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reverted = ctx.repo.db.transaction(() =>
      transitionInvoice(ctx, pending, "confirmed", { refundError: message }, Date.now()),
    )();
    return {
      invoice: reverted,
      txId: null,
      error: message,
      exitPending: err instanceof ExitPendingError,
    };
  }
}
