import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { createAdapter, MockTachiAdapter, type TachiAdapter } from "@opentill/adapter";
import type { GatewayConfig } from "./config";
import { openDb, type Db } from "./db";
import { Repo } from "./db/repo";
import { expireDueInvoices, type ServiceContext } from "./domain/invoices";
import { InvoiceEventBus, PayoutEventBus } from "./events";
import { PayoutPoller } from "./payout-poller";
import { Poller } from "./poller";
import { registerRoutes } from "./routes";
import { registerPublicRoutes } from "./public-routes";
import { WebhookDispatcher } from "./webhooks";

export interface AppOverrides {
  adapter?: TachiAdapter;
  db?: Db;
  logger?: boolean;
}

export interface App {
  app: FastifyInstance;
  config: GatewayConfig;
  db: Db;
  repo: Repo;
  adapter: TachiAdapter;
  ctx: ServiceContext;
  events: InvoiceEventBus;
  payoutEvents: PayoutEventBus;
  poller: Poller;
  payoutPoller: PayoutPoller;
  webhooks: WebhookDispatcher;
  /** Start the poller, expiry sweep and webhook retry timers. */
  startBackgroundJobs(): void;
  stopBackgroundJobs(): void;
  close(): Promise<void>;
}

/**
 * Wires config -> adapter -> db -> services -> HTTP. Background timers are NOT
 * started here so tests can drive `poller.tick()` deterministically.
 */
export async function createApp(config: GatewayConfig, overrides: AppOverrides = {}): Promise<App> {
  const app = Fastify({ logger: overrides.logger ?? false });

  const adapter =
    overrides.adapter ??
    createAdapter({
      mode: config.adapterMode,
      ...(config.tachi
        ? { tachi: { ...config.tachi, log: (msg, meta) => app.log.info(meta ?? {}, msg) } }
        : {}),
    });
  if (config.devPublicSimulate && !(adapter instanceof MockTachiAdapter)) {
    throw new Error(
      "OPENTILL_DEV_PUBLIC_SIMULATE=true requires the mock adapter — refusing to boot",
    );
  }
  await adapter.init();

  const db = overrides.db ?? openDb(config.dbPath);
  const repo = new Repo(db);

  const webhooks = new WebhookDispatcher({
    repo,
    secret: config.webhookSecret,
    sweepIntervalMs: config.webhookSweepIntervalMs,
    payoutWebhookUrl: config.payoutWebhookUrl,
    log: (msg, meta) => app.log.warn(meta ?? {}, msg),
  });

  const events = new InvoiceEventBus();
  const payoutEvents = new PayoutEventBus();

  // The webhook dispatcher consumes the same buses the SSE handlers do. The
  // subscriptions are synchronous, so each delivery row is written inside the
  // same SQLite transaction as the state change that produced it.
  events.subscribeAll((event) => {
    if (event.kind === "transition") {
      webhooks.enqueue(event.invoice, event.from, event.to, event.at);
    }
  });
  payoutEvents.subscribeAll((event) => {
    webhooks.enqueuePayout(event.payout, event.from, event.to, event.at);
  });

  const ctx: ServiceContext = { repo, adapter, events, payoutEvents };

  const flushWebhooks = () => {
    void webhooks.sweep().catch(() => {
      /* failures are recorded per-delivery; the sweep will retry */
    });
  };

  const poller = new Poller({
    ctx,
    intervalMs: config.pollIntervalMs,
    log: (msg, meta) => app.log.error(meta ?? {}, msg),
    onChanges: flushWebhooks,
  });

  const payoutPoller = new PayoutPoller({
    ctx,
    intervalMs: config.payoutPollIntervalMs,
    log: (msg, meta) => app.log.error(meta ?? {}, msg),
    onChanges: flushWebhooks,
  });

  let expiryTimer: NodeJS.Timeout | null = null;

  const startBackgroundJobs = (): void => {
    poller.start();
    payoutPoller.start();
    webhooks.start();
    if (!expiryTimer) {
      expiryTimer = setInterval(() => {
        try {
          if (expireDueInvoices(ctx) > 0) flushWebhooks();
        } catch (err) {
          app.log.error({ err }, "expiry sweep failed");
        }
      }, config.expirySweepIntervalMs);
      expiryTimer.unref?.();
    }
  };

  const stopBackgroundJobs = (): void => {
    poller.stop();
    payoutPoller.stop();
    webhooks.stop();
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = null;
  };

  // Built checkout bundle, when present. `wildcard: false` registers one route
  // per existing file (checkout.html, /assets/*) instead of a catch-all, so
  // API routes can never be shadowed.
  const webDistAvailable = existsSync(join(config.webDistPath, "checkout.html"));
  if (webDistAvailable) {
    await app.register(fastifyStatic, {
      root: config.webDistPath,
      prefix: "/",
      index: false,
      wildcard: false,
    });
  }

  await registerRoutes(app, { config, ctx, flushWebhooks });
  await registerPublicRoutes(app, {
    config,
    ctx,
    webDistAvailable,
    pokePoller: async () => {
      await poller.tick();
    },
  });

  return {
    app,
    config,
    db,
    repo,
    adapter,
    ctx,
    events,
    payoutEvents,
    poller,
    payoutPoller,
    webhooks,
    startBackgroundJobs,
    stopBackgroundJobs,
    async close() {
      stopBackgroundJobs();
      await app.close();
      await adapter.close?.();
      db.close();
    },
  };
}
