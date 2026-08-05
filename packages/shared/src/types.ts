export const INVOICE_STATUSES = [
  "pending",
  "paid",
  "confirmed",
  "expired",
  "underpaid",
  "refund_pending",
  "refunded",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type PaymentStatus = "seen" | "committed";

/** Domain representation of an invoice. Amounts are bigint sats. */
export interface Invoice {
  id: string;
  status: InvoiceStatus;
  amountSats: bigint;
  amountPaidSats: bigint;
  shortfallSats: bigint | null;
  address: string;
  memo: string | null;
  orderId: string | null;
  webhookUrl: string | null;
  returnUrl: string | null;
  refundAddress: string | null;
  refundTxId: string | null;
  refundError: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** When the invoice first reached `confirmed` (unix ms), else null. */
  confirmedAt: number | null;
}

/** Domain representation of a settlement-layer payment observed by the poller. */
export interface Payment {
  id: string;
  paymentId: string;
  invoiceId: string | null;
  address: string;
  amountSats: bigint;
  status: PaymentStatus;
  latePayment: boolean;
  observedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Wire (JSON) shape of an invoice: bigints become decimal strings. */
export interface InvoiceDTO {
  id: string;
  status: InvoiceStatus;
  amountSats: string;
  amountPaidSats: string;
  shortfallSats: string | null;
  address: string;
  paymentUri: string;
  memo: string | null;
  orderId: string | null;
  webhookUrl: string | null;
  returnUrl: string | null;
  refundAddress: string | null;
  refundTxId: string | null;
  refundError: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  confirmedAt: number | null;
}

export interface PaymentDTO {
  paymentId: string;
  invoiceId: string | null;
  address: string;
  amountSats: string;
  status: PaymentStatus;
  latePayment: boolean;
  observedAt: number;
}

/**
 * What the unauthenticated checkout page may see. The invoice id is the
 * bearer capability for this view; merchant metadata (orderId, webhookUrl,
 * refund details) must NEVER appear here.
 */
export interface PublicInvoiceDTO {
  id: string;
  status: InvoiceStatus;
  amountSats: string;
  amountPaidSats: string;
  memo: string | null;
  address: string;
  paymentUri: string;
  /** Storefront name shown in the checkout header (OPENTILL_MERCHANT_NAME). */
  merchantName: string;
  /** Merchant's "back to the store" link; shown on terminal states. */
  returnUrl: string | null;
  createdAt: number;
  expiresAt: number;
  /** True when any payment against this invoice arrived after expiry. */
  latePayment: boolean;
  /** True only when the gateway exposes the public dev-simulate route. */
  devSimulate: boolean;
}

// ---- payouts (money out) ----------------------------------------------------

export type PayoutKind = "cooperative" | "exit";

export const PAYOUT_STATUSES = [
  "initiated",
  "broadcasting",
  "waiting_timelock",
  "settled",
  "failed",
] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Domain representation of a merchant withdrawal. Amounts are bigint sats. */
export interface Payout {
  /** Gateway id (po_...). */
  id: string;
  /** Adapter/settlement-layer id. */
  payoutId: string;
  kind: PayoutKind;
  toAddress: string;
  amountSats: bigint;
  status: PayoutStatus;
  timelockBlocksRemaining: number | null;
  txId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface PayoutDTO {
  id: string;
  payoutId: string;
  kind: PayoutKind;
  toAddress: string;
  amountSats: string;
  status: PayoutStatus;
  timelockBlocksRemaining: number | null;
  txId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

/** Body POSTed to OPENTILL_PAYOUT_WEBHOOK_URL on payout status changes. */
export interface PayoutWebhookPayload {
  payoutId: string;
  kind: PayoutKind;
  toAddress: string;
  amountSats: string;
  previousStatus: PayoutStatus | null;
  status: PayoutStatus;
  txId: string | null;
  timelockBlocksRemaining: number | null;
  timestamp: number;
}

/** GET /api/stats. All totals are decimal sat strings. */
export interface StatsDTO {
  confirmedCount: number;
  confirmedTotalSats: string;
  pendingCount: number;
  refundedCount: number;
  refundedTotalSats: string;
  underpaidCount: number;
  expiredCount: number;
  last24h: { confirmedCount: number; confirmedTotalSats: string };
}

/** Merchant view of one webhook delivery. `url` has its query string redacted. */
export interface WebhookDeliveryDTO {
  id: string;
  /** Exactly one of invoiceId / payoutId is set. */
  invoiceId: string | null;
  payoutId: string | null;
  url: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookPayload {
  invoiceId: string;
  orderId: string | null;
  previousStatus: InvoiceStatus | null;
  status: InvoiceStatus;
  amountSats: string;
  amountPaidSats: string;
  timestamp: number;
}
