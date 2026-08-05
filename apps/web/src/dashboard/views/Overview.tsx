import { useState } from "react";
import type { InvoiceDTO, PayoutDTO, StatsDTO } from "@opentill/shared";
import { formatBtc, formatSats } from "../../shared/format";
import { api, findPendingExit, type Balance } from "../api";
import { InvoiceTable, StatCard } from "../components";
import { navigate } from "../router";
import { usePolling } from "../usePolling";

export function Overview() {
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [recent, setRecent] = useState<InvoiceDTO[] | null>(null);
  const [pendingExit, setPendingExit] = useState<PayoutDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePolling(async () => {
    try {
      const [s, b, l, p] = await Promise.all([
        api.stats(),
        api.balance(),
        api.listInvoices({ limit: 10 }),
        api.listPayouts({ limit: 50 }),
      ]);
      setStats(s);
      setBalance(b);
      setRecent(l.invoices);
      setPendingExit(findPendingExit(p.payouts));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <OverviewView
      stats={stats}
      balance={balance}
      recent={recent}
      pendingExit={pendingExit}
      error={error}
      onOpenInvoice={(id) => navigate(`/invoices/${id}`)}
    />
  );
}

export function ExitBanner({ exit }: { exit: PayoutDTO }) {
  return (
    <div className="banner-exit" role="status">
      <span>
        Unilateral exit in progress —{" "}
        <strong className="mono">{exit.timelockBlocksRemaining ?? "…"} blocks remaining</strong>.{" "}
        <span className="mono">{formatSats(exit.amountSats)} sats</span> are on their way to
        Bitcoin. Off-chain spending is locked until it settles.
      </span>
    </div>
  );
}

/**
 * The orange hero is earned by having money: zero balance renders the dark
 * (chrome) variant. Presentational conditional only.
 */
export function BalanceHeroes({
  balance,
  pendingExit,
  onWithdraw,
}: {
  balance: Balance | null;
  pendingExit?: PayoutDTO | null;
  onWithdraw?: () => void;
}) {
  const offchain = balance?.offchainSats ?? "0";
  const hasFunds = offchain !== "0" || Boolean(pendingExit);

  return (
    <div className="hero-grid">
      <div className={hasFunds ? "hero-card is-orange" : "hero-card is-dark is-zero"}>
        <div className="hero-label">Spendable now · off-chain</div>
        <div className="hero-value">
          {balance ? formatSats(offchain) : "—"} <span className="unit">sats</span>
        </div>
        {hasFunds ? (
          <div className="hero-sub">
            {balance ? `${formatBtc(offchain)} BTC` : ""} · instant, yours to move any time
          </div>
        ) : (
          <div className="hero-sub is-prose">
            The till is empty — your first confirmed invoice fills it. The card turns orange when
            there's money in it.
          </div>
        )}
        {pendingExit ? (
          <div className="hero-foot">
            exiting · {pendingExit.timelockBlocksRemaining ?? "…"} blocks remaining ·{" "}
            {formatSats(pendingExit.amountSats)} sats in flight
          </div>
        ) : (
          onWithdraw &&
          hasFunds && (
            <button type="button" className="btn-onaccent" onClick={onWithdraw}>
              Withdraw
            </button>
          )
        )}
      </div>
      <div className="hero-card is-dark">
        <div className="hero-label">On-chain · settled</div>
        <div className="hero-value">
          {balance ? formatSats(balance.onchainSats) : "—"} <span className="unit">sats</span>
        </div>
        <div className="hero-sub">plain Bitcoin · withdrawing needs no one's permission</div>
      </div>
    </div>
  );
}

export function OverviewView({
  stats,
  balance,
  recent,
  pendingExit,
  error,
  onOpenInvoice,
}: {
  stats: StatsDTO | null;
  balance: Balance | null;
  recent: InvoiceDTO[] | null;
  pendingExit?: PayoutDTO | null;
  error?: string | null;
  onOpenInvoice?: (id: string) => void;
}) {
  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">Overview</h1>
        <a href="#/pos" className="btn-primary" style={{ textDecoration: "none" }}>
          + New charge
        </a>
      </div>

      {error && <p className="banner-error">{error}</p>}

      <BalanceHeroes
        balance={balance}
        pendingExit={pendingExit}
        onWithdraw={() => navigate("/payouts")}
      />

      {pendingExit && <ExitBanner exit={pendingExit} />}

      <div className="stat-grid">
        <StatCard
          label="All-time confirmed"
          value={stats ? formatSats(stats.confirmedTotalSats) : "—"}
          sub={stats ? `sats · ${stats.confirmedCount} invoices` : ""}
        />
        <StatCard
          label="Last 24h"
          value={stats ? formatSats(stats.last24h.confirmedTotalSats) : "—"}
          sub={stats ? `sats · ${stats.last24h.confirmedCount} confirmed` : ""}
        />
        <StatCard
          label="Pending"
          value={stats ? String(stats.pendingCount) : "—"}
          sub="awaiting payment"
        />
        <StatCard
          label="Refunded total"
          value={stats ? formatSats(stats.refundedTotalSats) : "—"}
          sub={stats ? `sats · ${stats.refundedCount} refunds` : ""}
        />
      </div>

      <section className="sheet">
        <div className="sheet-head">
          <h2 className="sheet-title">Recent invoices</h2>
          <a className="sheet-link" href="#/invoices">
            View all →
          </a>
        </div>
        <InvoiceTable invoices={recent} onRowClick={onOpenInvoice} />
      </section>
    </div>
  );
}
