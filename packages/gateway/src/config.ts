import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPIRY_SWEEP_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS,
} from "@opentill/shared";
import type { AdapterMode, TachiAdapterConfig } from "@opentill/adapter";
import { dirname, join } from "node:path";

/** Production build output of apps/web, served by @fastify/static. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

export interface GatewayConfig {
  apiKey: string;
  webhookSecret: string;
  dbPath: string;
  adapterMode: AdapterMode;
  port: number;
  host: string;
  pollIntervalMs: number;
  expirySweepIntervalMs: number;
  webhookSweepIntervalMs: number;
  /** Dev-only routes are mounted only when this is true. */
  devRoutesEnabled: boolean;
  /**
   * Unauthenticated POST /dev/pay/:invoiceId for checkout demos. Effective
   * only with the mock adapter outside production; loadConfig refuses to boot
   * when the env var is set with a non-mock adapter.
   */
  devPublicSimulate: boolean;
  /** Interval between SSE heartbeat events on /pay/api/:id/events. */
  sseHeartbeatMs: number;
  /** Merchant-level webhook URL for payout status changes; null = disabled. */
  payoutWebhookUrl: string | null;
  /** Interval of the payout status sweep. */
  payoutPollIntervalMs: number;
  /** Directory holding the built checkout page (apps/web/dist). */
  webDistPath: string;
  /** Storefront name shown to customers in the checkout header. */
  merchantName: string;
  /** Real-settlement settings; null unless ADAPTER_MODE=tachi. */
  tachi: Omit<TachiAdapterConfig, "log"> | null;
}

export const DEFAULT_TACHI_RPC_URL = "https://rpc-regtest.tachibtc.com";

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const apiKey = env.OPENTILL_API_KEY;
  if (!apiKey) throw new Error("OPENTILL_API_KEY is required (see .env.example)");

  const webhookSecret = env.OPENTILL_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("OPENTILL_WEBHOOK_SECRET is required (see .env.example)");

  const rawMode = env.ADAPTER_MODE ?? "mock";
  if (rawMode !== "mock" && rawMode !== "tachi") {
    throw new Error(`ADAPTER_MODE must be "mock" or "tachi", got ${JSON.stringify(rawMode)}`);
  }
  const adapterMode: AdapterMode = rawMode;

  const rawSimulate = env.OPENTILL_DEV_PUBLIC_SIMULATE ?? "false";
  if (rawSimulate !== "true" && rawSimulate !== "false") {
    throw new Error(
      `OPENTILL_DEV_PUBLIC_SIMULATE must be "true" or "false", got ${JSON.stringify(rawSimulate)}`,
    );
  }
  if (rawSimulate === "true" && adapterMode !== "mock") {
    throw new Error(
      "OPENTILL_DEV_PUBLIC_SIMULATE=true requires ADAPTER_MODE=mock — unauthenticated payment " +
        "simulation must never reach a real settlement layer; refusing to boot",
    );
  }

  const dbPath = env.OPENTILL_DB_PATH ?? "./opentill.db";

  let tachi: GatewayConfig["tachi"] = null;
  if (adapterMode === "tachi") {
    const mnemonic = env.TACHI_MNEMONIC?.trim();
    if (!mnemonic) {
      throw new Error(
        "ADAPTER_MODE=tachi requires TACHI_MNEMONIC (BIP-39; every merchant key derives from it) — see README",
      );
    }
    const network = env.TACHI_NETWORK ?? "regtest";
    if (network !== "regtest" && network !== "signet") {
      throw new Error(`TACHI_NETWORK must be "regtest" or "signet", got ${JSON.stringify(network)}`);
    }
    tachi = {
      rpcUrl: env.TACHI_RPC_URL || DEFAULT_TACHI_RPC_URL,
      network,
      mnemonic,
      statePath: env.TACHI_STATE_PATH || join(dirname(dbPath), "tachi-adapter.json"),
      ...(env.TACHI_API_KEY ? { apiKey: env.TACHI_API_KEY } : {}),
    };
  }

  return {
    apiKey,
    webhookSecret,
    dbPath,
    adapterMode,
    port: intFromEnv(env, "PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    pollIntervalMs: intFromEnv(env, "POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    expirySweepIntervalMs: intFromEnv(
      env,
      "EXPIRY_SWEEP_INTERVAL_MS",
      DEFAULT_EXPIRY_SWEEP_INTERVAL_MS,
    ),
    webhookSweepIntervalMs: intFromEnv(
      env,
      "WEBHOOK_SWEEP_INTERVAL_MS",
      DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS,
    ),
    devRoutesEnabled: env.NODE_ENV !== "production" && adapterMode === "mock",
    devPublicSimulate:
      rawSimulate === "true" && adapterMode === "mock" && env.NODE_ENV !== "production",
    sseHeartbeatMs: intFromEnv(env, "SSE_HEARTBEAT_MS", DEFAULT_SSE_HEARTBEAT_MS),
    payoutWebhookUrl: env.OPENTILL_PAYOUT_WEBHOOK_URL || null,
    payoutPollIntervalMs: intFromEnv(env, "PAYOUT_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    webDistPath: env.OPENTILL_WEB_DIST ?? DEFAULT_WEB_DIST,
    merchantName: env.OPENTILL_MERCHANT_NAME?.trim() || "OpenTill",
    tachi,
  };
}
