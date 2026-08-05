/** Default invoice lifetime when the caller does not specify one. */
export const DEFAULT_EXPIRY_SECONDS = 15 * 60;

/** Bounds accepted for `expiresInSeconds` on invoice creation. */
export const MIN_EXPIRY_SECONDS = 30;
export const MAX_EXPIRY_SECONDS = 24 * 60 * 60;

/** How often the poller asks the adapter for new settlement events. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** How often the expiry sweep runs. */
export const DEFAULT_EXPIRY_SWEEP_INTERVAL_MS = 10_000;

/** How often the webhook retry sweep runs. */
export const DEFAULT_WEBHOOK_SWEEP_INTERVAL_MS = 5_000;

/** Delay before each retry, indexed by attempt count already made. Length == max attempts. */
export const WEBHOOK_BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000] as const;

/** Total delivery attempts before a webhook is abandoned. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length;

export const WEBHOOK_SIGNATURE_HEADER = "x-opentill-signature";

/** Interval between `event: heartbeat` frames on the public SSE stream. */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export const SATS_PER_BTC = 100_000_000n;
