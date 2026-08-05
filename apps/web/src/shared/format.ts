/** U+2009 THIN SPACE — receipt-style digit grouping: `50 000`. */
const THIN_SPACE = " ";
const SATS_PER_BTC = 100_000_000n;

/** `"50000"` -> `"50 000"`. Input is a decimal string of sats. */
export function formatSats(sats: string): string {
  return sats.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/** `"50000"` -> `"0.00050000"` — always 8 decimals (v2 type rule: BTC 8-decimal). */
export function formatBtc(sats: string): string {
  const abs = BigInt(sats);
  const whole = abs / SATS_PER_BTC;
  const frac = (abs % SATS_PER_BTC).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

/** `inv_9f3k2m7xq0a2c7` -> `inv_9f3k…a2c7` for receipt rows; short ids pass through. */
export function truncateId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Milliseconds remaining -> `mm:ss`, clamped at 00:00. Overflows hours into minutes. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Unix ms -> local `2026-07-21 14:03` (receipt line). */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
