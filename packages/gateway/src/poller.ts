import { applyIncomingPayment, type ServiceContext } from "./domain/invoices";

export interface PollerOptions {
  ctx: ServiceContext;
  intervalMs: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Called after each tick that changed something — lets the webhook sweep run promptly. */
  onChanges?: () => void;
}

export interface PollResult {
  applied: number;
  cursor: string | null;
}

/**
 * Cursor-driven settlement poller. The adapter call is network IO and happens
 * outside the transaction; everything it returns is then applied together with
 * the new cursor in ONE SQLite transaction (see `tick`). A crash before commit
 * replays the same batch on restart, which is safe because
 * `applyIncomingPayment` is idempotent on (paymentId, status).
 */
export class Poller {
  readonly #ctx: ServiceContext;
  readonly #intervalMs: number;
  readonly #log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly #onChanges: () => void;
  #timer: NodeJS.Timeout | null = null;
  #inFlight = false;

  constructor(opts: PollerOptions) {
    this.#ctx = opts.ctx;
    this.#intervalMs = opts.intervalMs;
    this.#log = opts.log ?? (() => {});
    this.#onChanges = opts.onChanges ?? (() => {});
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.#log("poll tick failed", { error: err instanceof Error ? err.message : String(err) });
      });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One poll cycle. Safe to call directly in tests. */
  async tick(): Promise<PollResult> {
    if (this.#inFlight) return { applied: 0, cursor: this.#ctx.repo.getCursor() };
    this.#inFlight = true;
    try {
      const cursor = this.#ctx.repo.getCursor();
      const { payments, nextCursor } = await this.#ctx.adapter.pollIncoming(cursor);

      // ---- single transaction: payment rows + invoice transitions + queued
      // ---- webhooks + poll cursor all commit or none do.
      const applied = this.#ctx.repo.db.transaction(() => {
        const now = Date.now();
        for (const p of payments) {
          applyIncomingPayment(this.#ctx, p, now);
        }
        this.#ctx.repo.setCursor(nextCursor, now);
        return payments.length;
      })();

      if (applied > 0) this.#onChanges();
      return { applied, cursor: nextCursor };
    } finally {
      this.#inFlight = false;
    }
  }
}
