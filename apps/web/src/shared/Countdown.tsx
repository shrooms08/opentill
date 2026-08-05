import { useEffect, useState } from "react";
import { formatCountdown } from "./format";

const DANGER_THRESHOLD_MS = 2 * 60 * 1000;

/** Same 250ms tick the component has always used — presentation only. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * v2 countdown: label + digits + depletion bar; shifts amber under 2:00
 * (class swap only, digits pulse). `createdAt` scales the bar.
 */
export function Countdown({ expiresAt, createdAt }: { expiresAt: number; createdAt: number }) {
  const now = useNow();
  const remaining = Math.max(0, expiresAt - now);
  const total = Math.max(1, expiresAt - createdAt);
  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  const urgent = remaining < DANGER_THRESHOLD_MS;

  return (
    <div className={urgent ? "count is-urgent" : "count"}>
      <div className="count-row">
        <span>Expires in</span>
        <span className="digits">{formatCountdown(remaining)}</span>
      </div>
      <div className="count-track">
        <div className="count-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
