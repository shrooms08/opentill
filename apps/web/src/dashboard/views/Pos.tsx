import { useEffect, useRef, useState } from "react";
import type { InvoiceDTO } from "@opentill/shared";
import { useNow } from "../../shared/Countdown";
import { formatBtc, formatCountdown, formatSats } from "../../shared/format";
import { Qr } from "../../shared/Qr";
import type { PublicInvoice } from "../../shared/types";
import { useInvoice } from "../../shared/useInvoice";
import { api } from "../api";

/** After the confirmed flood, auto-reset to step 1 (design 05). */
const POS_AUTORESET_MS = 8_000;

/**
 * POS v2: step 1 giant underlined amount, step 2 white QR block + orange
 * waiting dot, CONFIRMED = full orange flood (market-stall glance test). The
 * flood auto-resets to step 1 after 8s (Gate 7); tapping "New charge" cancels
 * the timer and resets immediately.
 */
export function Pos() {
  const [charge, setCharge] = useState<InvoiceDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (amountSats: string, memo: string) => {
    setError(null);
    try {
      setCharge(await api.createInvoice({ amountSats, memo: memo || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!charge) return <PosForm onCreate={create} error={error} />;
  return <PosLiveContainer invoiceId={charge.id} onReset={() => setCharge(null)} />;
}

function PosLiveContainer({ invoiceId, onReset }: { invoiceId: string; onReset: () => void }) {
  const { invoice, notFound } = useInvoice(invoiceId);
  return <PosLive invoice={invoice} notFound={notFound} onReset={onReset} />;
}

const LIVE_LABEL: Record<string, string> = {
  pending: "Waiting",
  partial: "Arriving",
  paid: "Finalizing",
  underpaid: "Underpaid",
  expired: "Expired",
  refund_pending: "Refunding",
  refunded: "Refunded",
};

export function PosLive({
  invoice,
  notFound,
  onReset,
}: {
  invoice: PublicInvoice | null;
  notFound: boolean;
  onReset: () => void;
}) {
  const now = useNow();
  const resetTimer = useRef<number | null>(null);
  const confirmed = invoice?.status === "confirmed";

  // Auto-reset the confirmed flood back to step 1 after 8s.
  useEffect(() => {
    if (!confirmed) return;
    resetTimer.current = window.setTimeout(() => onReset(), POS_AUTORESET_MS);
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, [confirmed, onReset]);

  // Tapping "New charge" cancels the auto-reset and resets immediately.
  const resetNow = () => {
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    onReset();
  };

  if (notFound) {
    return (
      <div className="pos-stage">
        <p className="muted">This charge disappeared — start a new one.</p>
        <button type="button" className="btn-secondary pos-cancel" onClick={onReset}>
          Cancel
        </button>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="pos-stage">
        <div className="skel-rows" style={{ width: 280 }}>
          <div className="skel" style={{ width: "60%" }} />
          <div className="skel" style={{ width: "100%" }} />
          <div className="skel" style={{ width: "80%" }} />
        </div>
      </div>
    );
  }

  if (invoice.status === "confirmed") {
    return (
      <div className="pos-flood">
        <div className="pos-flood-inner">
          <div className="pos-flood-paid">Paid</div>
          <div className="pos-flood-amt">
            {formatSats(invoice.amountPaidSats)} <span className="unit">sats</span>
          </div>
          {invoice.memo && <div className="pos-flood-memo">{invoice.memo}</div>}
          <button type="button" className="btn-onaccent" onClick={resetNow}>
            New charge
          </button>
        </div>
      </div>
    );
  }

  const partial = invoice.status === "pending" && BigInt(invoice.amountPaidSats) > 0n;
  const viewKey = partial ? "partial" : invoice.status;
  const label = LIVE_LABEL[viewKey] ?? invoice.status;
  const live = invoice.status === "pending" || invoice.status === "paid";
  const remaining = Math.max(0, invoice.expiresAt - now);

  return (
    <div className="pos-stage">
      <div className="pos-live">
        <Qr value={invoice.paymentUri} size="pos" />
        <div>
          <div className="pos-live-merchant">{invoice.merchantName}</div>
          <div className="pos-live-amt">{formatSats(invoice.amountSats)}</div>
          <div className="pos-live-unit">sats</div>
          <div className={partial || invoice.status === "paid" ? "pos-wait is-green" : "pos-wait"}>
            {live && <span className="dot" />}
            {label}
            {invoice.status === "pending" && <> · {formatCountdown(remaining)}</>}
          </div>
          {partial && (
            <div className="withdraw-hint" style={{ marginTop: 10 }}>
              {formatSats(invoice.amountPaidSats)} of {formatSats(invoice.amountSats)} sats
              received
            </div>
          )}
          <button type="button" className="btn-secondary pos-cancel" onClick={onReset}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function PosForm({
  onCreate,
  error,
}: {
  onCreate: (amountSats: string, memo: string) => void | Promise<void>;
  error?: string | null;
}) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);

  const valid = /^\d+$/.test(amount) && BigInt(amount || "0") > 0n;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onCreate(amount, memo.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pos-stage">
      <form className="pos-form" onSubmit={(e) => void submit(e)}>
        <div className="pos-kicker">New charge</div>
        <div className="pos-amount-row">
          <input
            id="pos-amount"
            className="pos-amount"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            placeholder="0"
            size={Math.max(1, amount.length)}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
            aria-label="Amount in sats"
          />
          <span className="pos-unit">sats</span>
        </div>
        <p className="pos-btc">{valid ? `≈ ${formatBtc(amount)} BTC` : "— BTC"}</p>

        <input
          className="ot-input pos-memo"
          placeholder="Memo (optional)"
          value={memo}
          maxLength={512}
          onChange={(e) => setMemo(e.target.value)}
          aria-label="Memo"
        />

        <button type="submit" className="btn-primary pos-create" disabled={!valid || busy}>
          {busy ? "Creating…" : "Create charge"}
        </button>
        {error && <p className="pos-error">{error}</p>}
      </form>
    </div>
  );
}
