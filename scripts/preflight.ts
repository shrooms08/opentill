/**
 * Stage preflight: one PASS/FAIL table for everything the demo depends on.
 * Read-only — no invoices, no payments, no deploys. Keys are read from the
 * local env files and only ever sent as Authorization headers; never printed.
 *
 *   npm run preflight
 *
 * Exits 1 if any check fails. Every request times out after 8s and all
 * checks run in parallel, so the whole run stays well under ~15s.
 */
import { existsSync, readFileSync } from "node:fs";
import { MerchantKeyring } from "@opentill/adapter";

const LIVE = process.env.PREFLIGHT_LIVE_URL ?? "https://opentill-live-production.up.railway.app";
const DEMO = process.env.PREFLIGHT_DEMO_URL ?? "https://opentill-demo-production.up.railway.app";
const RPC = process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const MIN_TILL = 10_000n;
const MIN_CUSTOMER = 25_000n;
const TIMEOUT_MS = 8_000;

/** Reads one KEY=value from a local env file without echoing it. */
function envValue(file: string, key: string): string {
  if (!existsSync(file)) throw new Error(`${file} not found (run from the repo root)`);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) {
      const v = m[2]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (v) return v;
    }
  }
  throw new Error(`${key} missing in ${file}`);
}

async function getJson(url: string, key?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

const fmt = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

type Result = { name: string; ok: boolean; detail: string };
type Check = { name: string; run: () => Promise<{ ok: boolean; detail: string }> };

const checks: Check[] = [
  {
    name: "live /healthz (tachi)",
    run: async () => {
      const { status, body } = await getJson(`${LIVE}/healthz`);
      const ok = status === 200 && body?.ok === true && body?.adapterMode === "tachi" && body?.dbOk === true;
      return { ok, detail: `HTTP ${status} adapterMode=${body?.adapterMode} dbOk=${body?.dbOk}` };
    },
  },
  {
    name: "demo /healthz (mock)",
    run: async () => {
      const { status, body } = await getJson(`${DEMO}/healthz`);
      const ok = status === 200 && body?.ok === true && body?.adapterMode === "mock" && body?.dbOk === true;
      return { ok, detail: `HTTP ${status} adapterMode=${body?.adapterMode} dbOk=${body?.dbOk}` };
    },
  },
  {
    name: "live /api/stats with live key",
    run: async () => {
      const { status, body } = await getJson(`${LIVE}/api/stats`, envValue(".env.railway-live", "OPENTILL_API_KEY"));
      return { ok: status === 200, detail: `HTTP ${status}${status === 200 ? ` confirmed=${body?.confirmedCount}` : ""}` };
    },
  },
  {
    name: "demo spendable > 0",
    run: async () => {
      const { status, body } = await getJson(`${DEMO}/api/balance`, envValue(".env.railway-demo", "OPENTILL_API_KEY"));
      const sats = status === 200 ? BigInt(body?.offchainSats ?? "0") : 0n;
      return { ok: status === 200 && sats > 0n, detail: `HTTP ${status} spendable=${fmt(sats)} sats` };
    },
  },
  {
    name: "Tachi RPC reachable",
    run: async () => {
      const [health, st] = await Promise.all([getJson(`${RPC}/health`), getJson(`${RPC}/tachi_status`)]);
      const height = Number(st.body?.result?.sync_info?.latest_block_height ?? NaN);
      const catchingUp = st.body?.result?.sync_info?.catching_up;
      const ok = health.status === 200 && st.status === 200 && Number.isFinite(height) && catchingUp !== true;
      return { ok, detail: `health HTTP ${health.status} height=${Number.isFinite(height) ? height : "?"} catchingUp=${catchingUp}` };
    },
  },
  {
    name: `live till >= ${fmt(MIN_TILL)} sats`,
    run: async () => {
      // Till address from the live gateway (public data), balance from the ledger itself.
      const bal = await getJson(`${LIVE}/api/balance`, envValue(".env.railway-live", "OPENTILL_API_KEY"));
      const till: string | undefined = bal.body?.tillAddress ?? undefined;
      if (bal.status !== 200 || !till) return { ok: false, detail: `no till address (HTTP ${bal.status})` };
      const { status, body } = await getJson(`${RPC}/tachi_balance?address=${encodeURIComponent(till)}`);
      const sats = BigInt(body?.balance_sat ?? 0);
      return { ok: status === 200 && sats >= MIN_TILL, detail: `${fmt(sats)} sats at ${till.slice(0, 10)}…${till.slice(-8)}` };
    },
  },
  {
    name: `pay:tachi customer >= ${fmt(MIN_CUSTOMER)} sats`,
    run: async () => {
      // Same key scripts/tachi-pay.ts pays from: receive chain index 1 of the smoke state.
      if (!existsSync(".tachi-smoke-state.json")) return { ok: false, detail: ".tachi-smoke-state.json not found" };
      const smoke = JSON.parse(readFileSync(".tachi-smoke-state.json", "utf8")) as { mnemonic: string };
      const customer = (await MerchantKeyring.fromMnemonic(smoke.mnemonic, "regtest")).derive(1, false);
      const { status, body } = await getJson(`${RPC}/tachi_balance?address=${encodeURIComponent(customer.address)}`);
      const sats = BigInt(body?.balance_sat ?? 0);
      return {
        ok: status === 200 && sats >= MIN_CUSTOMER,
        detail: `${fmt(sats)} sats at ${customer.address.slice(0, 10)}…${customer.address.slice(-8)}`,
      };
    },
  },
];

const started = Date.now();
const results: Result[] = await Promise.all(
  checks.map(async (c) => {
    try {
      return { name: c.name, ...(await c.run()) };
    } catch (err) {
      const msg = err instanceof Error ? (err.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS / 1000}s` : err.message) : String(err);
      return { name: c.name, ok: false, detail: msg };
    }
  }),
);

const w = Math.max(...results.map((r) => r.name.length));
console.log(`\nOpenTill stage preflight — ${new Date().toISOString()}\n`);
console.log(`  ${"CHECK".padEnd(w)}  RESULT  DETAIL`);
console.log(`  ${"-".repeat(w)}  ------  ${"-".repeat(40)}`);
for (const r of results) console.log(`  ${r.name.padEnd(w)}  ${r.ok ? "PASS  " : "FAIL  "}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
process.exit(failed === 0 ? 0 : 1);
