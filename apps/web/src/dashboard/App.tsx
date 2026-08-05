import { useEffect, useState } from "react";
import { api, ApiError, clearKey, getStoredKey, storeKey, UNAUTHORIZED_EVENT } from "./api";
import { useHashRoute } from "./router";
import { Overview } from "./views/Overview";
import { Invoices } from "./views/Invoices";
import { Payouts } from "./views/Payouts";
import { Pos } from "./views/Pos";

export function App() {
  const [unlocked, setUnlocked] = useState(() => getStoredKey() !== null);

  useEffect(() => {
    // Any 401 anywhere clears the key (api.ts) and lands back on the prompt.
    const onUnauthorized = () => setUnlocked(false);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!unlocked) return <KeyPrompt onUnlocked={() => setUnlocked(true)} />;
  return (
    <Shell
      onLock={() => {
        clearKey();
        setUnlocked(false);
      }}
    />
  );
}

function Wordmark({ className }: { className: string }) {
  return (
    <div className={className}>
      Open<span className="accent">Till</span>
    </div>
  );
}

export function KeyPrompt({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    storeKey(key);
    try {
      await api.stats(); // cheapest authenticated call — proves the key
      onUnlocked();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Key rejected by the server. Enter it again."
          : "Couldn't reach the gateway.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-form" onSubmit={(e) => void submit(e)}>
        <Wordmark className="gate-wordmark" />
        <p className="gate-sub">
          Enter the API key from your server's <span className="mono">.env</span> (
          <span className="mono">OPENTILL_API_KEY</span>).
        </p>
        {error && <div className="gate-error">{error}</div>}
        <input
          type="password"
          className={error ? "gate-input is-error" : "gate-input"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          aria-label="API key"
        />
        <button
          type="submit"
          className="btn-primary gate-btn"
          disabled={!value.trim() || busy}
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
        <div className="gate-foot">Self-hosted · your key never leaves this browser</div>
      </form>
    </div>
  );
}

/**
 * Honest mock-mode marker: a slim persistent footer bar shown on every
 * dashboard view while the gateway reports `adapterMode: "mock"`, absent when
 * the settlement adapter is real. Presentational only — reads /healthz.
 */
export function MockModeBanner({ adapterMode }: { adapterMode: string | null }) {
  if (adapterMode !== "mock") return null;
  return (
    <div className="mock-banner" role="status">
      <span className="mock-dot" />
      <span className="mono">
        Mock settlement mode — no real Bitcoin moves. See INTEGRATION.md
      </span>
    </div>
  );
}

function Shell({ onLock }: { onLock: () => void }) {
  const route = useHashRoute();
  const [adapterMode, setAdapterMode] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .health()
      .then((h) => {
        if (live) setAdapterMode(h.adapterMode);
      })
      .catch(() => {
        /* health probe is best-effort; no banner if unreachable */
      });
    return () => {
      live = false;
    };
  }, []);

  let view: React.ReactNode;
  let section: string;
  if (route === "/pos") {
    view = <Pos />;
    section = "pos";
  } else if (route === "/payouts") {
    view = <Payouts />;
    section = "payouts";
  } else if (route.startsWith("/invoices")) {
    const match = route.match(/^\/invoices\/([^/]+)/);
    view = <Invoices detailId={match?.[1] ?? null} />;
    section = "invoices";
  } else {
    view = <Overview />;
    section = "overview";
  }

  const link = (href: string, label: string, key: string) => (
    <a href={href} className={section === key ? "nav-link active" : "nav-link"}>
      {label}
    </a>
  );

  return (
    <div className="dash">
      <aside className="dash-side">
        <Wordmark className="wordmark" />
        <nav className="dash-nav">
          {link("#/", "Overview", "overview")}
          {link("#/invoices", "Invoices", "invoices")}
          {link("#/pos", "New charge", "pos")}
          {link("#/payouts", "Payouts", "payouts")}
        </nav>
        <div className="dash-side-foot">
          <span className="dash-version">v0.6 · self-hosted</span>
          <button type="button" className="lock-btn" onClick={onLock}>
            Lock
          </button>
        </div>
      </aside>
      <main className="dash-main">{view}</main>
      <MockModeBanner adapterMode={adapterMode} />
    </div>
  );
}
