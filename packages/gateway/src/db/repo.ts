import { randomUUID } from "node:crypto";
import type {
  Invoice,
  InvoiceStatus,
  Payment,
  PaymentStatus,
  Payout,
  PayoutKind,
  PayoutStatus,
} from "@opentill/shared";
import type { Db } from "./index";

interface InvoiceRow {
  id: string;
  status: string;
  amount_sats: string;
  amount_paid_sats: string;
  shortfall_sats: string | null;
  address: string;
  memo: string | null;
  order_id: string | null;
  webhook_url: string | null;
  return_url: string | null;
  refund_address: string | null;
  refund_tx_id: string | null;
  refund_error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  confirmed_at: number | null;
}

interface PaymentRow {
  id: string;
  payment_id: string;
  invoice_id: string | null;
  address: string;
  amount_sats: string;
  status: string;
  late_payment: number;
  observed_at: number;
  created_at: number;
  updated_at: number;
}

interface PayoutRow {
  id: string;
  payout_id: string;
  kind: string;
  to_address: string;
  amount_sats: string;
  status: string;
  timelock_blocks_remaining: number | null;
  tx_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

export function rowToPayout(row: PayoutRow): Payout {
  return {
    id: row.id,
    payoutId: row.payout_id,
    kind: row.kind as PayoutKind,
    toAddress: row.to_address,
    amountSats: BigInt(row.amount_sats),
    status: row.status as PayoutStatus,
    timelockBlocksRemaining: row.timelock_blocks_remaining,
    txId: row.tx_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

export interface WebhookDelivery {
  id: string;
  /** Exactly one of invoiceId / payoutId is set. */
  invoiceId: string | null;
  payoutId: string | null;
  url: string;
  body: string;
  signature: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WebhookRow {
  id: string;
  invoice_id: string | null;
  payout_id: string | null;
  url: string;
  body: string;
  signature: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    status: row.status as InvoiceStatus,
    amountSats: BigInt(row.amount_sats),
    amountPaidSats: BigInt(row.amount_paid_sats),
    shortfallSats: row.shortfall_sats === null ? null : BigInt(row.shortfall_sats),
    address: row.address,
    memo: row.memo,
    orderId: row.order_id,
    webhookUrl: row.webhook_url,
    returnUrl: row.return_url,
    refundAddress: row.refund_address,
    refundTxId: row.refund_tx_id,
    refundError: row.refund_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
  };
}

export function rowToPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    paymentId: row.payment_id,
    invoiceId: row.invoice_id,
    address: row.address,
    amountSats: BigInt(row.amount_sats),
    status: row.status as PaymentStatus,
    latePayment: row.late_payment === 1,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWebhook(row: WebhookRow): WebhookDelivery {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    payoutId: row.payout_id,
    url: row.url,
    body: row.body,
    signature: row.signature,
    status: row.status as WebhookDelivery["status"],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewInvoice {
  amountSats: bigint;
  address: string;
  memo: string | null;
  orderId: string | null;
  webhookUrl: string | null;
  returnUrl: string | null;
  expiresAt: number;
}

/** Hand-written SQL, prepared once per Db instance. */
export class Repo {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  insertInvoice(input: NewInvoice, now: number = Date.now()): Invoice {
    const id = `inv_${randomUUID().replace(/-/g, "")}`;
    this.db
      .prepare(
        `INSERT INTO invoices
          (id, status, amount_sats, amount_paid_sats, shortfall_sats, address, memo, order_id,
           webhook_url, return_url, refund_address, refund_tx_id, refund_error, created_at, updated_at, expires_at)
         VALUES (?, 'pending', ?, '0', NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.amountSats.toString(),
        input.address,
        input.memo,
        input.orderId,
        input.webhookUrl,
        input.returnUrl,
        now,
        now,
        input.expiresAt,
      );
    const invoice = this.getInvoice(id);
    if (!invoice) throw new Error(`invoice ${id} vanished immediately after insert`);
    return invoice;
  }

  getInvoice(id: string): Invoice | null {
    const row = this.db
      .prepare<[string], InvoiceRow>("SELECT * FROM invoices WHERE id = ?")
      .get(id);
    return row ? rowToInvoice(row) : null;
  }

  getInvoiceByAddress(address: string): Invoice | null {
    const row = this.db
      .prepare<[string], InvoiceRow>("SELECT * FROM invoices WHERE address = ?")
      .get(address);
    return row ? rowToInvoice(row) : null;
  }

  /**
   * `q` matches order_id exactly OR the invoice id by prefix (LIKE wildcards
   * in the input are escaped — `q` is literal text, not a pattern).
   */
  #invoiceFilter(opts: { status?: InvoiceStatus; q?: string }): {
    where: string;
    params: string[];
  } {
    const clauses: string[] = [];
    const params: string[] = [];
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    if (opts.q) {
      const escaped = opts.q.replace(/[\\%_]/g, (m) => `\\${m}`);
      clauses.push("(order_id = ? OR id LIKE ? || '%' ESCAPE '\\')");
      params.push(opts.q, escaped);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  listInvoices(opts: {
    status?: InvoiceStatus;
    q?: string;
    limit: number;
    offset: number;
  }): Invoice[] {
    const { where, params } = this.#invoiceFilter(opts);
    return this.db
      .prepare<unknown[], InvoiceRow>(
        `SELECT * FROM invoices ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset)
      .map(rowToInvoice);
  }

  countInvoices(status?: InvoiceStatus, q?: string): number {
    const { where, params } = this.#invoiceFilter({ status, q });
    const row = this.db
      .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM invoices ${where}`)
      .get(...params);
    return row?.n ?? 0;
  }

  /** Invoices still pending whose expiry has passed. */
  findExpirable(now: number): Invoice[] {
    return this.db
      .prepare<[number], InvoiceRow>(
        "SELECT * FROM invoices WHERE status = 'pending' AND expires_at <= ?",
      )
      .all(now)
      .map(rowToInvoice);
  }

  /** Applies a status change plus optional field updates. Callers must have validated the transition. */
  updateInvoice(
    id: string,
    patch: {
      status?: InvoiceStatus;
      amountPaidSats?: bigint;
      shortfallSats?: bigint | null;
      refundAddress?: string | null;
      refundTxId?: string | null;
      refundError?: string | null;
      confirmedAt?: number;
    },
    now: number = Date.now(),
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [now];

    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.amountPaidSats !== undefined) {
      sets.push("amount_paid_sats = ?");
      values.push(patch.amountPaidSats.toString());
    }
    if (patch.shortfallSats !== undefined) {
      sets.push("shortfall_sats = ?");
      values.push(patch.shortfallSats === null ? null : patch.shortfallSats.toString());
    }
    if (patch.refundAddress !== undefined) {
      sets.push("refund_address = ?");
      values.push(patch.refundAddress);
    }
    if (patch.refundTxId !== undefined) {
      sets.push("refund_tx_id = ?");
      values.push(patch.refundTxId);
    }
    if (patch.refundError !== undefined) {
      sets.push("refund_error = ?");
      values.push(patch.refundError);
    }
    if (patch.confirmedAt !== undefined) {
      sets.push("confirmed_at = ?");
      values.push(patch.confirmedAt);
    }

    values.push(id);
    this.db.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  getPaymentByPaymentId(paymentId: string): Payment | null {
    const row = this.db
      .prepare<[string], PaymentRow>("SELECT * FROM payments WHERE payment_id = ?")
      .get(paymentId);
    return row ? rowToPayment(row) : null;
  }

  /**
   * True when every credited (non-late) payment on the invoice is committed.
   * Drives the paid -> confirmed commit rule; see `maybeConfirm`.
   */
  allCreditedPaymentsCommitted(invoiceId: string): boolean {
    const row = this.db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM payments
         WHERE invoice_id = ? AND late_payment = 0 AND status != 'committed'`,
      )
      .get(invoiceId);
    return (row?.n ?? 0) === 0;
  }

  /** Aggregate dashboard stats in one SQL pass. `since` bounds the 24h window. */
  getStats(since: number): {
    confirmedCount: number;
    confirmedTotalSats: bigint;
    pendingCount: number;
    refundedCount: number;
    refundedTotalSats: bigint;
    underpaidCount: number;
    expiredCount: number;
    confirmed24hCount: number;
    confirmed24hTotalSats: bigint;
  } {
    const stmt = this.db.prepare<[number, number], Record<string, bigint | null>>(
      `SELECT
         SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
         SUM(CASE WHEN status = 'confirmed' THEN CAST(amount_paid_sats AS INTEGER) ELSE 0 END) AS confirmed_total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded_count,
         SUM(CASE WHEN status = 'refunded' THEN CAST(amount_paid_sats AS INTEGER) ELSE 0 END) AS refunded_total,
         SUM(CASE WHEN status = 'underpaid' THEN 1 ELSE 0 END) AS underpaid_count,
         SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired_count,
         SUM(CASE WHEN status = 'confirmed' AND confirmed_at >= ? THEN 1 ELSE 0 END) AS confirmed_24h_count,
         SUM(CASE WHEN status = 'confirmed' AND confirmed_at >= ? THEN CAST(amount_paid_sats AS INTEGER) ELSE 0 END) AS confirmed_24h_total
       FROM invoices`,
    );
    // TEXT sat amounts can exceed 2^53; read the aggregates as BigInt.
    stmt.safeIntegers(true);
    const row = stmt.get(since, since) ?? {};
    const n = (v: bigint | null | undefined) => Number(v ?? 0n);
    const b = (v: bigint | null | undefined) => v ?? 0n;
    return {
      confirmedCount: n(row.confirmed_count),
      confirmedTotalSats: b(row.confirmed_total),
      pendingCount: n(row.pending_count),
      refundedCount: n(row.refunded_count),
      refundedTotalSats: b(row.refunded_total),
      underpaidCount: n(row.underpaid_count),
      expiredCount: n(row.expired_count),
      confirmed24hCount: n(row.confirmed_24h_count),
      confirmed24hTotalSats: b(row.confirmed_24h_total),
    };
  }

  /** True when any payment against the invoice arrived after expiry. */
  hasLatePayment(invoiceId: string): boolean {
    const row = this.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ? AND late_payment = 1",
      )
      .get(invoiceId);
    return (row?.n ?? 0) > 0;
  }

  listPaymentsForInvoice(invoiceId: string): Payment[] {
    return this.db
      .prepare<[string], PaymentRow>(
        "SELECT * FROM payments WHERE invoice_id = ? ORDER BY observed_at ASC, id ASC",
      )
      .all(invoiceId)
      .map(rowToPayment);
  }

  insertPayment(
    input: {
      paymentId: string;
      invoiceId: string | null;
      address: string;
      amountSats: bigint;
      status: PaymentStatus;
      latePayment: boolean;
      observedAt: number;
    },
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO payments
          (id, payment_id, invoice_id, address, amount_sats, status, late_payment, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `pay_${randomUUID().replace(/-/g, "")}`,
        input.paymentId,
        input.invoiceId,
        input.address,
        input.amountSats.toString(),
        input.status,
        input.latePayment ? 1 : 0,
        input.observedAt,
        now,
        now,
      );
  }

  updatePaymentStatus(paymentId: string, status: PaymentStatus, now: number = Date.now()): void {
    this.db
      .prepare("UPDATE payments SET status = ?, updated_at = ? WHERE payment_id = ?")
      .run(status, now, paymentId);
  }

  // ---- payouts --------------------------------------------------------------

  insertPayout(
    input: {
      payoutId: string;
      kind: PayoutKind;
      toAddress: string;
      amountSats: bigint;
      status: PayoutStatus;
      timelockBlocksRemaining: number | null;
      txId: string | null;
      error: string | null;
    },
    now: number = Date.now(),
  ): Payout {
    const id = `po_${randomUUID().replace(/-/g, "")}`;
    this.db
      .prepare(
        `INSERT INTO payouts
          (id, payout_id, kind, to_address, amount_sats, status, timelock_blocks_remaining,
           tx_id, error, created_at, updated_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.payoutId,
        input.kind,
        input.toAddress,
        input.amountSats.toString(),
        input.status,
        input.timelockBlocksRemaining,
        input.txId,
        input.error,
        now,
        now,
        input.status === "settled" ? now : null,
      );
    const payout = this.getPayout(id);
    if (!payout) throw new Error(`payout ${id} vanished immediately after insert`);
    return payout;
  }

  getPayout(id: string): Payout | null {
    const row = this.db.prepare<[string], PayoutRow>("SELECT * FROM payouts WHERE id = ?").get(id);
    return row ? rowToPayout(row) : null;
  }

  getPayoutByAdapterId(payoutId: string): Payout | null {
    const row = this.db
      .prepare<[string], PayoutRow>("SELECT * FROM payouts WHERE payout_id = ?")
      .get(payoutId);
    return row ? rowToPayout(row) : null;
  }

  listPayouts(opts: { limit: number; offset: number }): Payout[] {
    return this.db
      .prepare<[number, number], PayoutRow>(
        "SELECT * FROM payouts ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      )
      .all(opts.limit, opts.offset)
      .map(rowToPayout);
  }

  countPayouts(): number {
    const row = this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM payouts").get();
    return row?.n ?? 0;
  }

  /** The exit currently sweeping the vault, if any. */
  findPendingExit(): Payout | null {
    const row = this.db
      .prepare<[], PayoutRow>(
        `SELECT * FROM payouts
         WHERE kind = 'exit' AND status NOT IN ('settled', 'failed')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    return row ? rowToPayout(row) : null;
  }

  updatePayout(
    id: string,
    patch: {
      status?: PayoutStatus;
      timelockBlocksRemaining?: number | null;
      txId?: string | null;
      error?: string | null;
      settledAt?: number;
    },
    now: number = Date.now(),
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [now];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.timelockBlocksRemaining !== undefined) {
      sets.push("timelock_blocks_remaining = ?");
      values.push(patch.timelockBlocksRemaining);
    }
    if (patch.txId !== undefined) {
      sets.push("tx_id = ?");
      values.push(patch.txId);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(patch.error);
    }
    if (patch.settledAt !== undefined) {
      sets.push("settled_at = ?");
      values.push(patch.settledAt);
    }
    values.push(id);
    this.db.prepare(`UPDATE payouts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  listWebhooksForPayout(payoutId: string): WebhookDelivery[] {
    return this.db
      .prepare<[string], WebhookRow>(
        "SELECT * FROM webhook_deliveries WHERE payout_id = ? ORDER BY created_at ASC",
      )
      .all(payoutId)
      .map(rowToWebhook);
  }

  // ---- adapter cursor -------------------------------------------------------

  getCursor(): string | null {
    const row = this.db
      .prepare<[], { cursor: string | null }>("SELECT cursor FROM adapter_state WHERE id = 1")
      .get();
    return row?.cursor ?? null;
  }

  setCursor(cursor: string, now: number = Date.now()): void {
    this.db
      .prepare("UPDATE adapter_state SET cursor = ?, updated_at = ? WHERE id = 1")
      .run(cursor, now);
  }

  // ---- webhooks -------------------------------------------------------------

  enqueueWebhook(
    input: {
      invoiceId?: string | null;
      payoutId?: string | null;
      url: string;
      body: string;
      signature: string;
    },
    now: number = Date.now(),
  ): string {
    const id = `whd_${randomUUID().replace(/-/g, "")}`;
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries
          (id, invoice_id, payout_id, url, body, signature, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.invoiceId ?? null,
        input.payoutId ?? null,
        input.url,
        input.body,
        input.signature,
        now,
        now,
        now,
      );
    return id;
  }

  findDueWebhooks(now: number, limit = 50): WebhookDelivery[] {
    return this.db
      .prepare<[number, number], WebhookRow>(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`,
      )
      .all(now, limit)
      .map(rowToWebhook);
  }

  getWebhook(id: string): WebhookDelivery | null {
    const row = this.db
      .prepare<[string], WebhookRow>("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(id);
    return row ? rowToWebhook(row) : null;
  }

  listWebhooksForInvoice(invoiceId: string): WebhookDelivery[] {
    return this.db
      .prepare<[string], WebhookRow>(
        "SELECT * FROM webhook_deliveries WHERE invoice_id = ? ORDER BY created_at ASC",
      )
      .all(invoiceId)
      .map(rowToWebhook);
  }

  /** Puts a given-up delivery back in the pending queue for one more attempt. */
  requeueWebhook(id: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'pending', next_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, id);
  }

  recordWebhookAttempt(
    id: string,
    result: {
      status: WebhookDelivery["status"];
      attempts: number;
      nextAttemptAt: number;
      statusCode: number | null;
      error: string | null;
    },
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.attempts,
        result.nextAttemptAt,
        result.statusCode,
        result.error,
        now,
        id,
      );
  }
}
