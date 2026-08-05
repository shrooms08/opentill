import { applyAdapterPayout } from "./domain/payouts";
import type { ServiceContext } from "./domain/invoices";

export interface PayoutPollerOptions {
  ctx: ServiceContext;
  intervalMs: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Called after a tick that changed something — nudges the webhook sweep. */
  onChanges?: () => void;
}

/**
 * 2s sweep over adapter.pollPayouts(), mirroring the invoice Poller's
 * discipline: the adapter call is network IO outside any transaction; every
 * snapshot it returned is folded in inside ONE SQLite transaction, so payout
 * rows and their enqueued webhooks commit together. Replays are safe because
 * applyAdapterPayout is idempotent on unchanged snapshots.
 */
export class PayoutPoller {
  readonly #ctx: ServiceContext;
  readonly #intervalMs: number;
  readonly #log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly #onChanges: () => void;
  #timer: NodeJS.Timeout | null = null;
  #inFlight = false;

  constructor(opts: PayoutPollerOptions) {
    this.#ctx = opts.ctx;
    this.#intervalMs = opts.intervalMs;
    this.#log = opts.log ?? (() => {});
    this.#onChanges = opts.onChanges ?? (() => {});
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.#log("payout poll tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One poll cycle. Safe to call directly in tests. Returns rows changed. */
  async tick(): Promise<number> {
    if (this.#inFlight) return 0;
    this.#inFlight = true;
    try {
      const snapshots = await this.#ctx.adapter.pollPayouts();
      if (snapshots.length === 0) return 0;

      const changed = this.#ctx.repo.db.transaction(() => {
        const now = Date.now();
        let n = 0;
        for (const snapshot of snapshots) {
          if (applyAdapterPayout(this.#ctx, snapshot, now) !== null) n += 1;
        }
        return n;
      })();

      if (changed > 0) this.#onChanges();
      return changed;
    } finally {
      this.#inFlight = false;
    }
  }
}
