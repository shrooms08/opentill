import { CopyButton } from "./CopyButton";
import { Countdown, useNow } from "./Countdown";
import { formatBtc, formatSats, formatTimestamp, truncateId } from "./format";
import { Qr } from "./Qr";
import type { PublicInvoice } from "./types";

export type ViewState =
  | "loading"
  | "notfound"
  | "pending"
  | "partial"
  | "paid"
  | "confirmed"
  | "underpaid"
  | "expired"
  | "refunded";

/**
 * `now` drives the underpaid boundary (Gate 7): the engine flips
 * pending → underpaid the instant a short payment lands, but while the
 * window is still open the customer can still top up — so we render the
 * GREEN "arriving" top-up state (design state 02) until `now >= expiresAt`,
 * then the amber expired-underpaid card. Purely presentational; no gateway
 * or state-machine change.
 */
export function deriveView(
  invoice: PublicInvoice | null,
  notFound: boolean,
  now: number = Date.now(),
): ViewState {
  if (notFound) return "notfound";
  if (!invoice) return "loading";
  switch (invoice.status) {
    case "pending":
      return BigInt(invoice.amountPaidSats) > 0n ? "partial" : "pending";
    case "paid":
      return "paid";
    case "confirmed":
      return "confirmed";
    case "underpaid":
      return now < invoice.expiresAt ? "partial" : "underpaid";
    case "expired":
      return "expired";
    case "refund_pending":
    case "refunded":
      return "refunded";
  }
}

export interface CheckoutStateProps {
  invoice: PublicInvoice | null;
  notFound: boolean;
  onSimulate?: () => void;
  simulateBusy?: boolean;
}

/**
 * Checkout v2: black card on black page. The dev-simulate button sits OUTSIDE
 * the card (dashed hairline + DEV chip), exactly as drawn.
 */
export function CheckoutState({ invoice, notFound, onSimulate, simulateBusy }: CheckoutStateProps) {
  // Same 250ms clock the countdown uses; flips the underpaid boundary live.
  const now = useNow();
  const view = deriveView(invoice, notFound, now);
  const wide = view === "pending"; // desktop 2-col applies to pending only

  if (view === "notfound") {
    return (
      <div className="ck-root">
        <div className="ck-notfound">
          <div className="ck-notfound-mark">OpenTill</div>
          <div className="ck-notfound-title">Not found</div>
          <div className="ck-notfound-sub">
            Check the link, or ask the merchant
            <br />
            for a new one.
          </div>
        </div>
      </div>
    );
  }

  if (view === "loading") {
    return (
      <div className="ck-root">
        <div className="ck-loading">
          <div className="ot-spinner" />
          <span>LOADING</span>
        </div>
      </div>
    );
  }

  const inv = invoice!;
  // Only genuinely pending invoices accept /dev/pay — an underpaid-but-open
  // invoice rendered as the green top-up state would 409, so no dev button there.
  const showSimulate = inv.devSimulate && Boolean(onSimulate) && inv.status === "pending";

  return (
    <div className={wide ? "ck-root is-wide" : "ck-root"} aria-live="polite">
      <section className={cardClass(view)} key={view}>
        {renderView(view, inv)}
      </section>
      {showSimulate && (
        <button type="button" className="ck-dev" onClick={onSimulate} disabled={simulateBusy}>
          <span className="ck-dev-chip">DEV</span>
          {simulateBusy ? "Simulating…" : "Simulate payment"}
        </button>
      )}
    </div>
  );
}

function cardClass(view: ViewState): string {
  if (view === "confirmed") return "ck-card is-confirmed";
  if (view === "expired") return "ck-card is-expired";
  return "ck-card";
}

function Head({
  merchant,
  label,
  tone,
}: {
  merchant: string;
  label: string;
  tone: "live" | "green-live" | "green" | "amber" | "gray" | "neutral";
}) {
  return (
    <header className="ck-head">
      <span className="ck-merchant">{merchant}</span>
      {tone === "live" || tone === "green-live" ? (
        <span className={tone === "live" ? "live-chip" : "live-chip is-green"}>
          <span className="dot" />
          {label}
        </span>
      ) : (
        <span className={`ck-state-label is-${tone}`}>{label}</span>
      )}
    </header>
  );
}

function AmountBlock({ invoice }: { invoice: PublicInvoice }) {
  return (
    <div className="ck-amount">
      <div className="ck-hero">{formatSats(invoice.amountSats)}</div>
      <div className="ck-unit-row">
        <span className="ck-unit">sats</span>
        <span className="ck-btc">{formatBtc(invoice.amountSats)} BTC</span>
      </div>
      {invoice.memo && <div className="ck-memo">{invoice.memo}</div>}
    </div>
  );
}

function Foot({ invoice, right }: { invoice: PublicInvoice; right?: boolean }) {
  return (
    <div className={right ? "ck-foot is-right" : "ck-foot"}>
      {!right && <span>{truncateId(invoice.id)}</span>}
      <span>Powered by OpenTill</span>
    </div>
  );
}

function ReturnToStore({ url }: { url: string | null }) {
  if (!url) return null;
  // Deliberately never an auto-redirect — the customer keeps their receipt moment.
  return (
    <a className="return-link" href={url}>
      Return to store →
    </a>
  );
}

function renderView(view: ViewState, inv: PublicInvoice) {
  const paid = BigInt(inv.amountPaidSats);
  const total = BigInt(inv.amountSats);
  const pct = total > 0n ? Number((paid * 100n) / total) : 0;

  switch (view) {
    case "pending":
    case "partial":
      return (
        <>
          <Head
            merchant={inv.merchantName}
            label={view === "partial" ? "ARRIVING" : "WAITING"}
            tone={view === "partial" ? "green-live" : "live"}
          />
          <AmountBlock invoice={inv} />
          {view === "partial" && (
            <div className="well-green ck-partial">
              <div className="ck-partial-row">
                <span>
                  {formatSats(inv.amountPaidSats)} of {formatSats(inv.amountSats)} received
                </span>
                <span>{pct}%</span>
              </div>
              <div className="ck-partial-track">
                <div className="ck-partial-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="ck-partial-hint">
                Send the remaining{" "}
                <span className="strong">{formatSats((total - paid).toString())} sats</span> to
                finish.
              </div>
            </div>
          )}
          <div className="ck-qr-wrap">
            <Qr value={inv.paymentUri} size={view === "partial" ? "compact" : "default"} />
          </div>
          <div className="ck-addr">
            <span className="ck-addr-text">{inv.address}</span>
            <CopyButton text={inv.address} />
          </div>
          <div className="ck-count">
            <Countdown expiresAt={inv.expiresAt} createdAt={inv.createdAt} />
          </div>
          <Foot invoice={inv} />
        </>
      );

    case "paid":
      // Continuity: header + amount frozen; the QR block's footprint becomes
      // the spinner well (150ms fade); address/countdown rows collapse.
      return (
        <>
          <Head merchant={inv.merchantName} label="RECEIVED" tone="green" />
          <AmountBlock invoice={inv} />
          <div className="ck-finalizing-well">
            <div className="ot-spinner" />
            <div className="ck-finalizing-label">Finalizing</div>
          </div>
          <Foot invoice={inv} />
        </>
      );

    case "confirmed":
      return (
        <>
          <Head merchant={inv.merchantName} label="CONFIRMED" tone="green" />
          <div className="ck-settle">
            <div className="ck-mega">Paid</div>
            <div className="ck-confirm-amt">
              {formatSats(inv.amountPaidSats)} <span className="unit">sats</span>
            </div>
            <div className="ck-btc">{formatBtc(inv.amountPaidSats)} BTC</div>
            {inv.memo && <div className="ck-memo">{inv.memo}</div>}
          </div>
          <div className="ck-rows">
            <div className="row">
              <span>Invoice</span>
              <span className="value">{truncateId(inv.id)}</span>
            </div>
            <div className="row">
              <span>Created</span>
              <span className="value">{formatTimestamp(inv.createdAt)}</span>
            </div>
          </div>
          <ReturnToStore url={inv.returnUrl} />
          <Foot invoice={inv} right />
        </>
      );

    case "underpaid":
      return (
        <>
          <Head merchant={inv.merchantName} label="UNDERPAID" tone="amber" />
          <div className="ck-amount">
            <div className="ck-under-hero">{formatSats(inv.amountPaidSats)}</div>
            <div className="ck-under-of">
              of <span className="strong">{formatSats(inv.amountSats)} sats</span> received
            </div>
            <div className="ck-under-track">
              <div className="ck-under-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="well-amber ck-under-well">
            The invoice expired before the full amount arrived. Your sats are with the merchant —
            contact them to settle or refund.
          </div>
          <div className="ck-rows">
            <div className="row">
              <span>Invoice</span>
              <span className="value">{truncateId(inv.id)}</span>
            </div>
          </div>
        </>
      );

    case "expired":
      return (
        <>
          <Head merchant={inv.merchantName} label="EXPIRED" tone="gray" />
          <div className="ck-amount">
            <div className="ck-expired-hero">Expired</div>
            <div className="ck-struck">{formatSats(inv.amountSats)} sats</div>
            {inv.memo && <div className="ck-memo">{inv.memo}</div>}
          </div>
          <div className="ck-expired-note">
            This invoice expired without payment. Ask the merchant for a new one.
          </div>
          {inv.latePayment && (
            <div className="well-amber ck-late-well">
              A payment arrived after expiry — contact the merchant.
            </div>
          )}
          <ReturnToStore url={inv.returnUrl} />
          <Foot invoice={inv} />
        </>
      );

    case "refunded":
      return (
        <>
          <Head
            merchant={inv.merchantName}
            label={inv.status === "refund_pending" ? "REFUNDING" : "REFUNDED"}
            tone="neutral"
          />
          <div className="ck-amount">
            <div className="ck-refund-hero">
              {inv.status === "refund_pending" ? "Refunding" : "Refunded"}
            </div>
            <div className="ck-refund-amt">
              {formatSats(inv.amountPaidSats)} <span className="unit">sats</span>
            </div>
            <div className="ck-statement-sub">
              {inv.status === "refund_pending"
                ? "on their way back to you"
                : "returned in full"}
              {inv.memo ? ` · ${inv.memo}` : ""}
            </div>
          </div>
          <div className="ck-rows">
            <div className="row">
              <span>Invoice</span>
              <span className="value">{truncateId(inv.id)}</span>
            </div>
          </div>
          <ReturnToStore url={inv.returnUrl} />
          <Foot invoice={inv} right />
        </>
      );

    // notfound/loading handled before the card renders
    default:
      return null;
  }
}
