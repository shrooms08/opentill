import { useEffect, useState } from "react";
import type { InvoiceStatus } from "@opentill/shared";
import { api, type InvoiceListResult } from "../api";
import { InvoiceTable } from "../components";
import { navigate } from "../router";
import { usePolling } from "../usePolling";
import { InvoiceDetail } from "./InvoiceDetail";

export const TABS: ReadonlyArray<{ label: string; status?: InvoiceStatus }> = [
  { label: "All" },
  { label: "Pending", status: "pending" },
  { label: "Confirmed", status: "confirmed" },
  { label: "Underpaid", status: "underpaid" },
  { label: "Expired", status: "expired" },
  { label: "Refunded", status: "refunded" },
];

const PAGE_SIZE = 25;

export function Invoices({ detailId }: { detailId: string | null }) {
  const [tab, setTab] = useState(0);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<InvoiceListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  usePolling(async () => {
    try {
      setData(
        await api.listInvoices({
          status: TABS[tab]?.status,
          q: debouncedQ || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tab, debouncedQ, page]);

  return (
    <>
      <InvoicesView
        data={data}
        error={error}
        activeTab={tab}
        onTab={(i) => {
          setTab(i);
          setPage(0);
        }}
        q={q}
        onQ={(value) => {
          setQ(value);
          setPage(0);
        }}
        page={page}
        pageSize={PAGE_SIZE}
        onPage={setPage}
        onRowClick={(id) => navigate(`/invoices/${id}`)}
      />
      {detailId && <InvoiceDetail id={detailId} onClose={() => navigate("/invoices")} />}
    </>
  );
}

export function InvoicesView({
  data,
  error,
  activeTab,
  onTab,
  q,
  onQ,
  page,
  pageSize,
  onPage,
  onRowClick,
}: {
  data: InvoiceListResult | null;
  error?: string | null;
  activeTab: number;
  onTab: (index: number) => void;
  q: string;
  onQ: (value: string) => void;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onRowClick?: (id: string) => void;
}) {
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = data ? Math.min(total, page * pageSize + data.invoices.length) : 0;
  const lastPage = total === 0 ? 0 : Math.ceil(total / pageSize) - 1;

  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">Invoices</h1>
        <input
          type="search"
          className="search"
          placeholder="Search order id or invoice id…"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          aria-label="Search invoices"
        />
      </div>

      {error && <p className="banner-error">{error}</p>}

      <div className="chips" role="tablist">
        {TABS.map((t, i) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={i === activeTab}
            className={i === activeTab ? "chip active" : "chip"}
            onClick={() => onTab(i)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section className="sheet">
        <InvoiceTable
          invoices={data?.invoices ?? null}
          onRowClick={onRowClick}
          emptyText={
            q || TABS[activeTab]?.status
              ? "Nothing matches this filter."
              : "Create your first charge and it will land here."
          }
        />
        {total > pageSize && (
          <footer className="pager">
            <span>
              Showing {from}–{to} of {total}
            </span>
            <span className="pager-btns">
              <button
                type="button"
                className="pager-btn"
                disabled={page === 0}
                onClick={() => onPage(page - 1)}
              >
                ‹ Prev
              </button>
              <button
                type="button"
                className="pager-btn"
                disabled={page >= lastPage}
                onClick={() => onPage(page + 1)}
              >
                Next ›
              </button>
            </span>
          </footer>
        )}
      </section>
    </div>
  );
}
