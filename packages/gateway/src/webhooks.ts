import { createHmac, timingSafeEqual } from "node:crypto";
import {
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SIGNATURE_HEADER,
  type Invoice,
  type InvoiceStatus,
  type Payout,
  type PayoutStatus,
  type PayoutWebhookPayload,
  type WebhookPayload,
} from "@opentill/shared";
import type { Repo } from "./db/repo";

export function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Constant-time signature check — exported for merchants and for our own tests. */
export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signBody(body, secret), "utf8");
  const given = Buffer.from(signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function buildPayload(
  invoice: Invoice,
  previousStatus: InvoiceStatus | null,
  status: InvoiceStatus,
  timestamp: number,
): WebhookPayload {
  return {
    invoiceId: invoice.id,
    orderId: invoice.orderId,
    previousStatus,
    status,
    amountSats: invoice.amountSats.toString(),
    amountPaidSats: invoice.amountPaidSats.toString(),
    timestamp,
  };
}

export function buildPayoutPayload(
  payout: Payout,
  previousStatus: PayoutStatus | null,
  status: PayoutStatus,
  timestamp: number,
): PayoutWebhookPayload {
  return {
    payoutId: payout.id,
    kind: payout.kind,
    toAddress: payout.toAddress,
    amountSats: payout.amountSats.toString(),
    previousStatus,
    status,
    txId: payout.txId,
    timelockBlocksRemaining: payout.timelockBlocksRemaining,
    timestamp,
  };
}

export interface WebhookDispatcherOptions {
  repo: Repo;
  secret: string;
  sweepIntervalMs: number;
  /** Merchant-level destination for payout status changes. Unset = no payout webhooks. */
  payoutWebhookUrl?: string | null;
  requestTimeoutMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Interval-driven webhook delivery. Rows are enqueued inside the same
 * transaction as the state change that produced them, so a crash between
 * "invoice changed" and "merchant told" is recoverable.
 */
export class WebhookDispatcher {
  readonly #repo: Repo;
  readonly #secret: string;
  readonly #sweepIntervalMs: number;
  readonly #payoutWebhookUrl: string | null;
  readonly #requestTimeoutMs: number;
  readonly #log: (msg: string, meta?: Record<string, unknown>) => void;
  #timer: NodeJS.Timeout | null = null;
  /** Serializes sweeps; each queued sweep starts only after the previous settles. */
  #chain: Promise<void> = Promise.resolve();

  constructor(opts: WebhookDispatcherOptions) {
    this.#repo = opts.repo;
    this.#secret = opts.secret;
    this.#sweepIntervalMs = opts.sweepIntervalMs;
    this.#payoutWebhookUrl = opts.payoutWebhookUrl ?? null;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.#log = opts.log ?? (() => {});
  }

  /**
   * Enqueue a delivery for a state change. MUST be called inside the same
   * SQLite transaction as the invoice update. Returns null when the invoice
   * has no webhook URL.
   */
  enqueue(
    invoice: Invoice,
    previousStatus: InvoiceStatus | null,
    status: InvoiceStatus,
    now: number = Date.now(),
  ): string | null {
    if (!invoice.webhookUrl) return null;
    const body = JSON.stringify(buildPayload(invoice, previousStatus, status, now));
    return this.#repo.enqueueWebhook(
      {
        invoiceId: invoice.id,
        url: invoice.webhookUrl,
        body,
        signature: signBody(body, this.#secret),
      },
      now,
    );
  }

  /**
   * Enqueue a payout status change to the merchant-level payout URL. Same
   * same-transaction requirement, same HMAC scheme, same retry machinery.
   * Returns null when no OPENTILL_PAYOUT_WEBHOOK_URL is configured.
   */
  enqueuePayout(
    payout: Payout,
    previousStatus: PayoutStatus | null,
    status: PayoutStatus,
    now: number = Date.now(),
  ): string | null {
    if (!this.#payoutWebhookUrl) return null;
    const body = JSON.stringify(buildPayoutPayload(payout, previousStatus, status, now));
    return this.#repo.enqueueWebhook(
      {
        payoutId: payout.id,
        url: this.#payoutWebhookUrl,
        body,
        signature: signBody(body, this.#secret),
      },
      now,
    );
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#sweepIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Deliver every due webhook. Safe to call directly (tests, post-transaction
   * nudge). Sweeps never run concurrently: a call made while one is in flight
   * queues behind it rather than being dropped, so a delivery enqueued mid-sweep
   * still goes out promptly and every caller's returned count is its own.
   */
  async sweep(now?: number): Promise<number> {
    const run = this.#chain.then(() => this.#runSweep(now));
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #runSweep(now: number | undefined): Promise<number> {
    const due = this.#repo.findDueWebhooks(now ?? Date.now());
    let delivered = 0;
    for (const d of due) {
      if (await this.#attempt(d.id)) delivered += 1;
    }
    return delivered;
  }

  async #attempt(id: string): Promise<boolean> {
    const delivery = this.#repo.getWebhook(id);
    if (!delivery || delivery.status !== "pending") return false;

    const attempts = delivery.attempts + 1;
    let statusCode: number | null = null;
    let error: string | null = null;

    try {
      const res = await fetch(delivery.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: delivery.signature,
        },
        body: delivery.body,
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      statusCode = res.status;
      if (!res.ok) error = `non-2xx response: ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const now = Date.now();
    if (error === null) {
      this.#repo.recordWebhookAttempt(
        id,
        { status: "delivered", attempts, nextAttemptAt: now, statusCode, error: null },
        now,
      );
      return true;
    }

    const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;
    const backoff = WEBHOOK_BACKOFF_MS[attempts] ?? 0;
    this.#repo.recordWebhookAttempt(
      id,
      {
        status: exhausted ? "failed" : "pending",
        attempts,
        nextAttemptAt: exhausted ? now : now + backoff,
        statusCode,
        error,
      },
      now,
    );
    this.#log("webhook delivery failed", {
      id,
      attempts,
      exhausted,
      url: delivery.url,
      error,
    });
    return false;
  }
}
