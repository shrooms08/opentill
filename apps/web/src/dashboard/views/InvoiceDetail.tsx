import { useState } from "react";
import type { WebhookDeliveryDTO } from "@opentill/shared";
import { formatSats } from "../../shared/format";
import { api, ApiError, type InvoiceWithPayments } from "../api";
import { EmptyState, fmtDate, IdChip, StatusPill } from "../components";
import { usePolling } from "../usePolling";

export interface RefundResultUi {
  ok: boolean;
  txId?: string;
  message?: string;
}

export function InvoiceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [invoice, setInvoice] = useState<InvoiceWithPayments | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [inv, del] = await Promise.all([api.getInvoice(id), api.webhookDeliveries(id)]);
      setInvoice(inv);
      setDeliveries(del.deliveries);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setError("Invoice not found.");
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  usePolling(load, [id]);

  const onRefund = async (toAddress: string): Promise<RefundResultUi> => {
    try {
      const result = await api.refund(id, toAddress);
      await load();
      return { ok: true, txId: result.txId };
    } catch (err) {
      await load();
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };

  const onRetry = async (deliveryId: string) => {
    try {
      await api.retryDelivery(deliveryId);
    } catch {
      /* the refreshed list will show the real state */
    }
    await load();
  };

  return (
    <InvoiceDetailView
      invoice={invoice}
      deliveries={deliveries}
      error={error}
      onClose={onClose}
      onRefund={onRefund}
      onRetry={onRetry}
    />
  );
}

function whStatusClass(status: WebhookDeliveryDTO["status"]): string {
  if (status === "delivered") return "wh-ok";
  if (status === "failed") return "wh-fail";
  return "wh-pending";
}

export function InvoiceDetailView({
  invoice,
  deliveries,
  error,
  onClose,
  onRefund,
  onRetry,
}: {
  invoice: InvoiceWithPayments | null;
  deliveries: WebhookDeliveryDTO[] | null;
  error?: string | null;
  onClose: () => void;
  onRefund: (toAddress: string) => Promise<RefundResultUi>;
  onRetry: (deliveryId: string) => void | Promise<void>;
}) {
  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <aside className="panel" aria-label="Invoice detail">
        <header className="panel-header">
          <div className="panel-title-row">
            <h2 className="panel-title">Invoice</h2>
            {invoice && <StatusPill status={invoice.status} variant="tint" />}
          </div>
          <button type="button" className="panel-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {invoice && (
          <div className="panel-meta">
            <IdChip id={invoice.id} onDark />
            <span>·</span>
            <a href={`/pay/${invoice.id}`} target="_blank" rel="noreferrer">
              Open checkout ↗
            </a>
          </div>
        )}

        {error && <p className="banner-error" style={{ marginTop: 14 }}>{error}</p>}
        {!invoice && !error && (
          <div className="skel-rows" style={{ marginTop: 20 }}>
            <div className="skel" style={{ width: "40%" }} />
            <div className="skel" style={{ width: "85%" }} />
            <div className="skel" style={{ width: "70%" }} />
          </div>
        )}

        {invoice && (
          <>
            <div className="panel-sheet">
              <div className="panel-sheet-grid">
                <div>
                  <div className="ps-label">Amount</div>
                  <div className="ps-big">
                    {formatSats(invoice.amountSats)} <span className="unit">sats</span>
                  </div>
                </div>
                <div>
                  <div className="ps-label">Paid</div>
                  <div className={invoice.amountPaidSats === "0" ? "ps-big" : "ps-big is-green"}>
                    {formatSats(invoice.amountPaidSats)} <span className="unit">sats</span>
                  </div>
                </div>
                {invoice.memo && (
                  <div>
                    <div className="ps-label">Memo</div>
                    <div className="ps-text">{invoice.memo}</div>
                  </div>
                )}
                {invoice.orderId && (
                  <div>
                    <div className="ps-label">Order</div>
                    <div className="ps-mono">{invoice.orderId}</div>
                  </div>
                )}
                <div>
                  <div className="ps-label">Created / expires</div>
                  <div className="ps-mono">
                    {fmtDate(invoice.createdAt)} → {fmtDate(invoice.expiresAt)}
                  </div>
                </div>
                {invoice.shortfallSats && (
                  <div>
                    <div className="ps-label">Shortfall</div>
                    <div className="ps-mono">{formatSats(invoice.shortfallSats)} sats</div>
                  </div>
                )}
                {invoice.confirmedAt !== null && (
                  <div>
                    <div className="ps-label">Confirmed</div>
                    <div className="ps-mono">{fmtDate(invoice.confirmedAt)}</div>
                  </div>
                )}
                <div>
                  <div className="ps-label">Address</div>
                  <div className="ps-mono">{invoice.address}</div>
                </div>
                {invoice.refundTxId && (
                  <div>
                    <div className="ps-label">Refund tx</div>
                    <div className="ps-mono">{invoice.refundTxId}</div>
                  </div>
                )}
                {invoice.refundError && (
                  <div>
                    <div className="ps-label">Refund error</div>
                    <div className="ps-text">{invoice.refundError}</div>
                  </div>
                )}
              </div>
            </div>

            <div className="panel-section">Payments</div>
            {invoice.payments.length === 0 ? (
              <EmptyState onDark>No payments observed yet.</EmptyState>
            ) : (
              <div className="sub-table">
                <div className="sub-head" style={{ gridTemplateColumns: "130px 1fr 120px" }}>
                  <span>Id</span>
                  <span className="num">Amount</span>
                  <span>Status</span>
                </div>
                {invoice.payments.map((p) => (
                  <div
                    key={p.paymentId}
                    className="sub-row"
                    style={{ gridTemplateColumns: "130px 1fr 120px" }}
                  >
                    <span className="dim" title={p.paymentId}>
                      {p.paymentId.slice(0, 14)}…
                    </span>
                    <span className="num">{formatSats(p.amountSats)}</span>
                    <span>
                      <span className={p.status === "committed" ? "wh-ok" : "wh-pending"}>
                        {p.status}
                      </span>
                      {p.latePayment && <span className="late-chip">late</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="panel-section">Webhook deliveries</div>
            {deliveries === null ? (
              <div className="skel-rows">
                <div className="skel" style={{ width: "60%" }} />
              </div>
            ) : deliveries.length === 0 ? (
              <EmptyState onDark>No deliveries — this invoice has no webhook URL.</EmptyState>
            ) : (
              <div className="sub-table">
                <div
                  className="sub-head"
                  style={{ gridTemplateColumns: "1fr 90px 70px 80px" }}
                >
                  <span>Url</span>
                  <span>Status</span>
                  <span className="num">Tries</span>
                  <span></span>
                </div>
                {deliveries.map((d) => (
                  <div
                    key={d.id}
                    className="sub-row"
                    style={{ gridTemplateColumns: "1fr 90px 70px 80px" }}
                  >
                    <span className="dim" title={d.url} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {d.url}
                    </span>
                    <span className={whStatusClass(d.status)}>{d.status}</span>
                    <span className="num">{d.attempts}</span>
                    <span style={{ justifySelf: "end" }}>
                      {d.status === "failed" && (
                        <button type="button" className="micro-btn" onClick={() => void onRetry(d.id)}>
                          Retry
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="panel-divider">
              <div className="panel-section" style={{ marginTop: 0 }}>
                Refund
              </div>
              <RefundFlow invoice={invoice} onRefund={onRefund} />
            </div>
          </>
        )}
      </aside>
    </>
  );
}

export function refundDisabledReason(status: InvoiceWithPayments["status"]): string | null {
  switch (status) {
    case "confirmed":
      return null;
    case "refunded":
      return "This invoice has already been refunded.";
    case "refund_pending":
      return "A refund is already in progress.";
    case "pending":
      return "Nothing to refund — no confirmed payment yet.";
    case "paid":
      return "Wait for the payment to finish confirming before refunding.";
    case "underpaid":
      return "Refunds require a confirmed invoice; this one is underpaid.";
    case "expired":
      return "Refunds require a confirmed invoice; this one expired unpaid.";
  }
}

export function RefundFlow({
  invoice,
  onRefund,
}: {
  invoice: InvoiceWithPayments;
  onRefund: (toAddress: string) => Promise<RefundResultUi>;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy" | "done" | "failed">("idle");
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<RefundResultUi | null>(null);

  const reason = refundDisabledReason(invoice.status);
  if (reason && step === "idle") {
    return (
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn-secondary" disabled>
          Refund unavailable
        </button>
        <p className="refund-disabled-note">{reason}</p>
      </div>
    );
  }

  const submit = async () => {
    setStep("busy");
    const r = await onRefund(address.trim());
    setResult(r);
    setStep(r.ok ? "done" : "failed");
  };

  switch (step) {
    case "idle":
      return (
        <button
          type="button"
          className="btn-secondary"
          style={{ marginTop: 12 }}
          onClick={() => setStep("confirm")}
        >
          Refund {formatSats(invoice.amountPaidSats)} sats…
        </button>
      );
    case "confirm":
      return (
        <div className="refund-box">
          <div className="refund-box-title">Refund this invoice</div>
          <div className="refund-label">Amount to return</div>
          <input
            className="ot-input refund-amount-input"
            value={formatSats(invoice.amountPaidSats)}
            readOnly
            aria-label="Amount to return"
          />
          <div className="refund-label">Destination address</div>
          <input
            className="ot-input mono"
            style={{ marginTop: 6 }}
            placeholder="tachi1q… or bc1q…"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label="Refund destination address"
          />
          <div className="refund-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={address.trim().length === 0}
              onClick={() => void submit()}
            >
              Send refund
            </button>
            <button type="button" className="btn-secondary" onClick={() => setStep("idle")}>
              Cancel
            </button>
          </div>
        </div>
      );
    case "busy":
      return (
        <div className="refund-progress">
          <div className="ot-spinner is-small" />
          <div>
            <div className="refund-progress-title">
              Sending {formatSats(invoice.amountPaidSats)} sats…
            </div>
            <div className="refund-progress-sub">to {address.trim()}</div>
          </div>
        </div>
      );
    case "done":
      return (
        <div className="result-well is-green">
          <div className="result-title">Refund sent</div>
          <div className="result-sub">
            {formatSats(invoice.amountPaidSats)} sats
            {result?.txId ? ` · ${result.txId}` : ""}
          </div>
        </div>
      );
    case "failed":
      return (
        <div className="result-well is-red">
          <div className="result-title">Refund failed</div>
          <div className="result-sub is-prose">{result?.message ?? "unknown error"}</div>
          <button type="button" className="micro-btn" onClick={() => setStep("confirm")}>
            Try again
          </button>
        </div>
      );
  }
}
