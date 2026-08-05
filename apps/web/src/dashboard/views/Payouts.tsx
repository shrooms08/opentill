import { useEffect, useRef, useState } from "react";
import type { PayoutDTO, PayoutKind } from "@opentill/shared";
import { formatSats } from "../../shared/format";
import { api, findPendingExit, type Balance } from "../api";
import { EmptyState, fmtDate, StatusPill } from "../components";
import { usePolling } from "../usePolling";
import { BalanceHeroes } from "./Overview";

export interface WithdrawResultUi {
  ok: boolean;
  message?: string;
}

export function Payouts() {
  const [payouts, setPayouts] = useState<PayoutDTO[] | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [list, b] = await Promise.all([api.listPayouts({ limit: 50 }), api.balance()]);
      setPayouts(list.payouts);
      setBalance(b);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  usePolling(load, []);

  const onWithdraw = async (body: {
    kind: PayoutKind;
    toAddress: string;
    amountSats?: string;
  }): Promise<WithdrawResultUi> => {
    try {
      await api.createPayout(body);
      await load();
      return { ok: true };
    } catch (err) {
      await load();
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };

  return <PayoutsView payouts={payouts} balance={balance} error={error} onWithdraw={onWithdraw} />;
}

export function PayoutsView({
  payouts,
  balance,
  error,
  onWithdraw,
}: {
  payouts: PayoutDTO[] | null;
  balance: Balance | null;
  error?: string | null;
  onWithdraw: (body: {
    kind: PayoutKind;
    toAddress: string;
    amountSats?: string;
  }) => Promise<WithdrawResultUi>;
}) {
  const pendingExit = findPendingExit(payouts ?? []);

  return (
    <div className="view">
      <div className="view-head">
        <h1 className="view-title">Payouts</h1>
      </div>

      {error && <p className="banner-error">{error}</p>}

      <BalanceHeroes balance={balance} pendingExit={pendingExit} />

      <WithdrawForm balance={balance} pendingExit={pendingExit} onWithdraw={onWithdraw} />

      <section className="sheet">
        <div className="sheet-head">
          <h2 className="sheet-title">Payout history</h2>
        </div>
        <PayoutTable payouts={payouts} />
      </section>
    </div>
  );
}

export function WithdrawForm({
  balance,
  pendingExit,
  onWithdraw,
}: {
  balance: Balance | null;
  pendingExit: PayoutDTO | null;
  onWithdraw: (body: {
    kind: PayoutKind;
    toAddress: string;
    amountSats?: string;
  }) => Promise<WithdrawResultUi>;
}) {
  const [kind, setKind] = useState<PayoutKind>("cooperative");
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WithdrawResultUi | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const spendable = balance?.offchainSats ?? "0";
  const addressOk = address.trim().length >= 4;
  const amountOk = /^\d+$/.test(amount) && BigInt(amount || "0") > 0n;
  const canSubmit = addressOk && (kind === "exit" || amountOk) && !busy && !pendingExit;

  const submit = async () => {
    setBusy(true);
    setResult(null);
    const r = await onWithdraw({
      kind,
      toAddress: address.trim(),
      ...(kind === "cooperative" ? { amountSats: amount } : {}),
    });
    if (!mounted.current) return;
    setBusy(false);
    setConfirmingExit(false);
    setResult(r);
    if (r.ok) {
      setAmount("");
      setAddress("");
    }
  };

  if (confirmingExit) {
    return (
      <section className="withdraw-card">
        <h2 className="withdraw-title">Confirm unilateral exit</h2>
        <div className="well-amber">
          This sweeps your <strong>entire off-chain balance</strong> —{" "}
          <span className="mono">{formatSats(spendable)} sats</span> — to{" "}
          <span className="mono">{address.trim()}</span> on Bitcoin. While the exit runs (~12
          blocks), all other spending from this balance is locked: no refunds, no withdrawals. It
          needs no one's permission and cannot be stopped once broadcast.
        </div>
        <div className="refund-actions" style={{ marginTop: 2 }}>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Broadcasting…" : "Exit now"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => setConfirmingExit(false)}
          >
            Back
          </button>
        </div>
        {result && !result.ok && <p className="error-text">{result.message}</p>}
      </section>
    );
  }

  return (
    <section className="withdraw-card">
      <h2 className="withdraw-title">Withdraw</h2>

      {pendingExit && (
        <p className="withdraw-hint">
          A unilateral exit is in progress — withdrawals unlock when it settles.
        </p>
      )}

      <div className="kind-cards" role="radiogroup" aria-label="Withdrawal kind">
        <button
          type="button"
          role="radio"
          aria-checked={kind === "cooperative"}
          className={kind === "cooperative" ? "kind-card selected" : "kind-card"}
          onClick={() => setKind("cooperative")}
        >
          <span className="kind-title">Cooperative withdrawal</span>
          <span className="kind-desc">
            Fast — usually seconds. The Tachi validators co-sign the transaction. This is the
            normal path.
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "exit"}
          className={kind === "exit" ? "kind-card selected" : "kind-card"}
          onClick={() => setKind("exit")}
        >
          <span className="kind-title">Unilateral exit</span>
          <span className="kind-desc">
            Sweeps your entire balance to Bitcoin, works without anyone's permission, takes ~12
            blocks. This is your escape hatch. It always works.
          </span>
        </button>
      </div>

      {kind === "cooperative" && (
        <div className="withdraw-amount-row">
          <input
            className="ot-input"
            inputMode="numeric"
            placeholder="Amount (sats)"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
            aria-label="Amount in sats"
          />
          <button
            type="button"
            className="btn-inverse"
            onClick={() => setAmount(spendable)}
            disabled={spendable === "0"}
          >
            MAX
          </button>
        </div>
      )}

      <input
        className="ot-input mono"
        placeholder="Bitcoin address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        aria-label="Destination Bitcoin address"
      />

      <div>
        <button
          type="button"
          className={kind === "exit" ? "btn-secondary" : "btn-primary"}
          disabled={!canSubmit}
          onClick={() => (kind === "exit" ? setConfirmingExit(true) : void submit())}
        >
          {busy ? "Working…" : kind === "exit" ? "Start unilateral exit…" : "Withdraw"}
        </button>
      </div>

      {result &&
        (result.ok ? (
          <p className="success-text">Payout initiated ✓</p>
        ) : (
          <p className="error-text">{result.message}</p>
        ))}
    </section>
  );
}

function AddrChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };
  const short = value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  return (
    <button type="button" className="id-chip" title={value} onClick={() => void copy()}>
      {copied ? "copied ✓" : short}
    </button>
  );
}

export function PayoutTable({ payouts }: { payouts: PayoutDTO[] | null }) {
  if (payouts === null) {
    return (
      <div className="skel-rows">
        <div className="skel" style={{ width: "40%" }} />
        <div className="skel" style={{ width: "85%" }} />
      </div>
    );
  }
  if (payouts.length === 0) {
    return (
      <EmptyState>No payouts yet — your funds stay off-chain until you withdraw them.</EmptyState>
    );
  }
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Kind</th>
            <th className="num">Amount</th>
            <th>To</th>
            <th>Status</th>
            <th>Tx</th>
            <th className="num hide-sm">Created</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p.id}>
              <td className="memo-cell">
                {p.kind === "exit" ? "Unilateral exit" : "Cooperative"}
              </td>
              <td className="num">{formatSats(p.amountSats)}</td>
              <td>
                <AddrChip value={p.toAddress} />
              </td>
              <td>
                <StatusPill status={p.status} variant="solid" />
                {p.status === "waiting_timelock" && (
                  <span className="timelock-cell">{p.timelockBlocksRemaining} blocks</span>
                )}
                {p.status === "failed" && p.error && (
                  <span className="error-text small">{p.error}</span>
                )}
              </td>
              <td>{p.txId ? <AddrChip value={p.txId} /> : <span className="dim">—</span>}</td>
              <td className="num dim hide-sm">{fmtDate(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
