import {
  buildPaymentUri,
  type Invoice,
  type InvoiceDTO,
  type Payment,
  type PaymentDTO,
  type Payout,
  type PayoutDTO,
  type PublicInvoiceDTO,
  type StatsDTO,
  type WebhookDeliveryDTO,
} from "@opentill/shared";
import type { Repo, WebhookDelivery } from "./db/repo";

export function toInvoiceDTO(invoice: Invoice): InvoiceDTO {
  return {
    id: invoice.id,
    status: invoice.status,
    amountSats: invoice.amountSats.toString(),
    amountPaidSats: invoice.amountPaidSats.toString(),
    shortfallSats: invoice.shortfallSats === null ? null : invoice.shortfallSats.toString(),
    address: invoice.address,
    paymentUri: buildPaymentUri(invoice.address, invoice.amountSats, invoice.memo),
    memo: invoice.memo,
    orderId: invoice.orderId,
    webhookUrl: invoice.webhookUrl,
    returnUrl: invoice.returnUrl,
    refundAddress: invoice.refundAddress,
    refundTxId: invoice.refundTxId,
    refundError: invoice.refundError,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
    expiresAt: invoice.expiresAt,
    confirmedAt: invoice.confirmedAt,
  };
}

/**
 * Serialization for the unauthenticated checkout page. Strict allowlist —
 * add a field here only if a customer standing at the till may see it.
 * `orderId`, `webhookUrl` and refund details must never pass through.
 */
export function toPublicInvoiceDTO(
  invoice: Invoice,
  opts: { latePayment: boolean; devSimulate: boolean; merchantName: string },
): PublicInvoiceDTO {
  return {
    id: invoice.id,
    status: invoice.status,
    amountSats: invoice.amountSats.toString(),
    amountPaidSats: invoice.amountPaidSats.toString(),
    memo: invoice.memo,
    address: invoice.address,
    paymentUri: buildPaymentUri(invoice.address, invoice.amountSats, invoice.memo),
    merchantName: opts.merchantName,
    returnUrl: invoice.returnUrl,
    createdAt: invoice.createdAt,
    expiresAt: invoice.expiresAt,
    latePayment: opts.latePayment,
    devSimulate: opts.devSimulate,
  };
}

export function toPaymentDTO(payment: Payment): PaymentDTO {
  return {
    paymentId: payment.paymentId,
    invoiceId: payment.invoiceId,
    address: payment.address,
    amountSats: payment.amountSats.toString(),
    status: payment.status,
    latePayment: payment.latePayment,
    observedAt: payment.observedAt,
  };
}

export function toPayoutDTO(payout: Payout): PayoutDTO {
  return {
    id: payout.id,
    payoutId: payout.payoutId,
    kind: payout.kind,
    toAddress: payout.toAddress,
    amountSats: payout.amountSats.toString(),
    status: payout.status,
    timelockBlocksRemaining: payout.timelockBlocksRemaining,
    txId: payout.txId,
    error: payout.error,
    createdAt: payout.createdAt,
    updatedAt: payout.updatedAt,
    settledAt: payout.settledAt,
  };
}

/** Query strings routinely carry tokens; the merchant view never echoes them. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}

/** Merchant view of a delivery. The signed body is internal and stays out. */
export function toWebhookDeliveryDTO(d: WebhookDelivery): WebhookDeliveryDTO {
  return {
    id: d.id,
    invoiceId: d.invoiceId,
    payoutId: d.payoutId,
    url: redactUrl(d.url),
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function toStatsDTO(stats: ReturnType<Repo["getStats"]>): StatsDTO {
  return {
    confirmedCount: stats.confirmedCount,
    confirmedTotalSats: stats.confirmedTotalSats.toString(),
    pendingCount: stats.pendingCount,
    refundedCount: stats.refundedCount,
    refundedTotalSats: stats.refundedTotalSats.toString(),
    underpaidCount: stats.underpaidCount,
    expiredCount: stats.expiredCount,
    last24h: {
      confirmedCount: stats.confirmed24hCount,
      confirmedTotalSats: stats.confirmed24hTotalSats.toString(),
    },
  };
}
