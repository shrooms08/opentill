export interface IncomingPayment {
  /** Unique id from the settlement layer (a vtxoId once the real adapter lands). */
  paymentId: string;
  toAddress: string;
  amountSats: bigint;
  /** unix ms */
  observedAt: number;
  status: "seen" | "committed";
}

/**
 * Two ways out of the vault:
 * - "cooperative": the validator quorum co-signs; fast; the normal path.
 * - "exit": the merchant broadcasts the exit leaf of the vault taproot tree
 *   alone; slow (timelock in blocks); works with every validator offline or
 *   hostile. The sovereignty guarantee the product is built on.
 */
export type PayoutKind = "cooperative" | "exit";

export type PayoutStatus = "initiated" | "broadcasting" | "waiting_timelock" | "settled" | "failed";

export interface AdapterPayout {
  payoutId: string;
  kind: PayoutKind;
  toAddress: string;
  /** For "exit": the full off-chain balance at initiation. */
  amountSats: bigint;
  status: PayoutStatus;
  /** Only meaningful for "exit" while waiting. */
  timelockBlocksRemaining?: number;
  txId?: string;
  error?: string;
}

export interface TachiAdapter {
  init(): Promise<void>;
  /** Derive a fresh receive address. Must be unique per call. */
  createReceiveAddress(ref: string): Promise<{ address: string }>;
  /** Poll for payments to any watched address after the cursor. Returns new payments + next cursor. */
  pollIncoming(cursor: string | null): Promise<{ payments: IncomingPayment[]; nextCursor: string }>;
  /** Register/unregister addresses the poller should care about. */
  watchAddress(address: string): Promise<void>;
  unwatchAddress(address: string): Promise<void>;
  /** Send sats out (refunds). Throws ExitPendingError while an exit is sweeping the vault. */
  send(params: { toAddress: string; amountSats: bigint; ref: string }): Promise<{ txId: string }>;
  getBalance(): Promise<{ offchainSats: bigint; onchainSats: bigint }>;
  /**
   * Start a withdrawal to on-chain Bitcoin. `amountSats` is required for
   * "cooperative" and ignored for "exit" (an exit sweeps the vault).
   * Validation failures come back as a payout with status "failed" (no debit).
   */
  initiatePayout(params: {
    kind: PayoutKind;
    toAddress: string;
    amountSats?: bigint;
  }): Promise<AdapterPayout>;
  /** Current status of all non-settled payouts (plus just-settled ones once). */
  pollPayouts(): Promise<AdapterPayout[]>;
  /** Release any timers/sockets held by the adapter. */
  close?(): Promise<void>;
}

export type AdapterMode = "mock" | "tachi";

export interface AdapterConfig {
  mode: AdapterMode;
  /** Starting off-chain balance for the mock ledger, in sats. Ignored by real adapters. */
  mockOpeningBalanceSats?: bigint;
  /** How long a mock payment stays `seen` before committing, in ms. */
  mockCommitLatencyMs?: number;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

/** Off-chain spending is blocked while a unilateral exit is sweeping the vault. */
export class ExitPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExitPendingError";
  }
}
