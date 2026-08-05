import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InvoiceDTO, InvoiceStatus } from "@opentill/shared";
import { formatSats } from "../shared/format";

/**
 * v2 two-surface pill system: `tint` on dark chrome (with live dot),
 * `solid` on the white sheet. Solids never on dark; tints never on white.
 */
export function StatusPill({
  status,
  variant = "tint",
}: {
  status: InvoiceStatus | string;
  variant?: "tint" | "solid";
}) {
  return (
    <span className={`pill pill-${variant}-${status}`}>
      {variant === "tint" && <span className="dot" />}
      {status.replace("_", " ")}
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
}

/** Truncated id that copies the full value on click (⧉ affordance via CSS). */
export function IdChip({ id, onDark = false }: { id: string; onDark?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      /* clipboard unavailable; the visual feedback is skipped */
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      className={onDark ? "id-chip on-dark" : "id-chip"}
      title={id}
      onClick={(e) => void copy(e)}
    >
      {copied ? "copied ✓" : `${id.slice(0, 12)}…`}
    </button>
  );
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** v2 empty state: oversized ghost title + sentence-case sub. */
export function EmptyState({
  title = "Nothing yet",
  onDark = false,
  children,
}: {
  title?: string;
  onDark?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={onDark ? "empty on-dark" : "empty"}>
      {!onDark && <div className="empty-title">{title}</div>}
      <p className="empty-sub">{children}</p>
    </div>
  );
}

function paidCellClass(inv: InvoiceDTO): string {
  if (inv.amountPaidSats === "0") return "num dim";
  if (inv.status === "underpaid") return "num paid-amber";
  return "num paid-green";
}

export function InvoiceTable({
  invoices,
  onRowClick,
  emptyText = "Create your first charge and it will land here.",
}: {
  invoices: InvoiceDTO[] | null;
  onRowClick?: (id: string) => void;
  emptyText?: string;
}) {
  if (invoices === null) {
    return (
      <div className="skel-rows">
        <div className="skel" style={{ width: "40%" }} />
        <div className="skel" style={{ width: "85%" }} />
        <div className="skel" style={{ width: "70%" }} />
      </div>
    );
  }
  if (invoices.length === 0) return <EmptyState>{emptyText}</EmptyState>;

  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Id</th>
            <th>Memo / order</th>
            <th className="num">Amount</th>
            <th className="num">Paid</th>
            <th>Status</th>
            <th className="num hide-sm">Created</th>
            <th className="num hide-sm">Expires</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr
              key={inv.id}
              className={onRowClick ? "clickable" : undefined}
              onClick={onRowClick ? () => onRowClick(inv.id) : undefined}
            >
              <td>
                <IdChip id={inv.id} />
              </td>
              <td className="memo-cell">
                {inv.memo ?? ""}
                {inv.orderId && <span className="order-id mono"> {inv.orderId}</span>}
              </td>
              <td className="num">{formatSats(inv.amountSats)}</td>
              <td className={paidCellClass(inv)}>
                {inv.amountPaidSats === "0" ? "—" : formatSats(inv.amountPaidSats)}
              </td>
              <td>
                <StatusPill status={inv.status} variant="solid" />
              </td>
              <td className="num dim hide-sm">{fmtDate(inv.createdAt)}</td>
              <td className="num dim hide-sm">{fmtDate(inv.expiresAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
