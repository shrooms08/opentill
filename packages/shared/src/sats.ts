import { SATS_PER_BTC } from "./constants";

/** Parse a decimal string of satoshis into a positive bigint. Throws on anything else. */
export function parseSats(input: string): bigint {
  if (!/^\d+$/.test(input)) {
    throw new RangeError(`invalid sats value: ${JSON.stringify(input)}`);
  }
  return BigInt(input);
}

/** Format sats as a BTC decimal string with 8 places, trailing zeros trimmed. */
export function satsToBtc(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = (abs % SATS_PER_BTC).toString().padStart(8, "0").replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/**
 * Build a BIP21-ish payment URI. The `bitcoin:` scheme is a placeholder for
 * Gate 1 — the real Tachi URI scheme lands with the real adapter.
 */
export function buildPaymentUri(address: string, amountSats: bigint, memo: string | null): string {
  const params = new URLSearchParams({ amount: satsToBtc(amountSats) });
  if (memo) params.set("label", memo);
  return `bitcoin:${address}?${params.toString()}`;
}
