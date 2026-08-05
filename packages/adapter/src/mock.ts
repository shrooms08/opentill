import { randomBytes } from "node:crypto";
import {
  ExitPendingError,
  InsufficientFundsError,
  type AdapterConfig,
  type AdapterPayout,
  type IncomingPayment,
  type PayoutKind,
  type TachiAdapter,
} from "./types";

const DEFAULT_COMMIT_LATENCY_MS = 1_000;
const BECH32M_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Cooperative payouts step initiated -> broadcasting -> settled, one step per interval. */
const COOPERATIVE_STEP_MS = 1_500;
/** One mock "block". Exits wait EXIT_TIMELOCK_BLOCKS of these. */
const EXIT_BLOCK_MS = 2_000;
const EXIT_TIMELOCK_BLOCKS = 12;

interface MockPayoutState {
  payoutId: string;
  kind: PayoutKind;
  toAddress: string;
  amountSats: bigint;
  status: AdapterPayout["status"];
  timelockBlocksRemaining: number | undefined;
  txId: string | undefined;
  error: string | undefined;
  /** Wall-clock driver for dev demos; tests use advanceBlocks() instead. */
  nextStepAt: number;
  /** Terminal payouts are reported by pollPayouts exactly once. */
  terminalReported: boolean;
}

interface MockPayment {
  paymentId: string;
  toAddress: string;
  amountSats: bigint;
  observedAt: number;
  status: "seen" | "committed";
  /** When the payment flips from `seen` to `committed`. */
  commitsAt: number;
  /** Set once the `committed` event has been appended to the log. */
  committedEventEmitted: boolean;
}

/**
 * Cursor is a monotonically increasing event sequence number. Every observable
 * change to a payment (first sighting, then commit) is appended to the log as a
 * separate event, so a caller that has read up to cursor N can always learn
 * about later commits without re-scanning. `nextCursor` is the seq of the last
 * event returned.
 */
interface LedgerEvent {
  seq: number;
  payment: IncomingPayment;
}

/**
 * In-memory stand-in for the Tachi settlement layer. Deterministic enough for
 * tests, lossy enough to be obviously not production.
 */
export class MockTachiAdapter implements TachiAdapter {
  readonly mode = "mock" as const;

  #initialized = false;
  #seq = 0;
  #addressCounter = 0;
  #events: LedgerEvent[] = [];
  #payments = new Map<string, MockPayment>();
  #payouts = new Map<string, MockPayoutState>();
  #watched = new Set<string>();
  #offchainSats: bigint;
  #onchainSats: bigint;
  readonly #commitLatencyMs: number;

  constructor(config: Pick<AdapterConfig, "mockOpeningBalanceSats" | "mockCommitLatencyMs"> = {}) {
    this.#offchainSats = config.mockOpeningBalanceSats ?? 0n;
    this.#onchainSats = 0n;
    this.#commitLatencyMs = config.mockCommitLatencyMs ?? DEFAULT_COMMIT_LATENCY_MS;
  }

  async init(): Promise<void> {
    this.#initialized = true;
  }

  async createReceiveAddress(ref: string): Promise<{ address: string }> {
    this.#assertInitialized();
    this.#addressCounter += 1;
    // Not a real bech32m encoding — just something that looks the part and is
    // unique per call. `ref` is folded in so mock addresses stay traceable.
    const entropy = Array.from(randomBytes(20))
      .map((b) => BECH32M_ALPHABET[b % BECH32M_ALPHABET.length])
      .join("");
    const tag = ref.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6);
    return { address: `mock1p${entropy}${tag}${this.#addressCounter.toString(36)}` };
  }

  async watchAddress(address: string): Promise<void> {
    this.#watched.add(address);
  }

  async unwatchAddress(address: string): Promise<void> {
    this.#watched.delete(address);
  }

  async pollIncoming(
    cursor: string | null,
  ): Promise<{ payments: IncomingPayment[]; nextCursor: string }> {
    this.#assertInitialized();
    this.#promoteCommitted();

    const from = parseCursor(cursor);
    const fresh = this.#events.filter(
      (e) => e.seq > from && this.#watched.has(e.payment.toAddress),
    );
    // Advance past every event we looked at, not just the watched ones —
    // unwatched addresses are never coming back.
    const lastSeen = this.#events.length > 0 ? this.#events[this.#events.length - 1]!.seq : from;

    return {
      payments: fresh.map((e) => ({ ...e.payment })),
      nextCursor: String(lastSeen),
    };
  }

  async send(params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ txId: string }> {
    this.#assertInitialized();
    if (this.#hasPendingExit()) {
      throw new ExitPendingError(
        "off-chain funds are locked: a unilateral exit is sweeping the vault",
      );
    }
    if (params.amountSats <= 0n) {
      throw new RangeError("send amount must be positive");
    }
    if (params.amountSats > this.#offchainSats) {
      throw new InsufficientFundsError(
        `balance ${this.#offchainSats} sats < requested ${params.amountSats} sats`,
      );
    }
    this.#offchainSats -= params.amountSats;
    return { txId: `mocktx_${randomBytes(16).toString("hex")}` };
  }

  async getBalance(): Promise<{ offchainSats: bigint; onchainSats: bigint }> {
    return { offchainSats: this.#offchainSats, onchainSats: this.#onchainSats };
  }

  // ---- payouts --------------------------------------------------------------

  async initiatePayout(params: {
    kind: PayoutKind;
    toAddress: string;
    amountSats?: bigint;
  }): Promise<AdapterPayout> {
    this.#assertInitialized();
    const now = Date.now();
    const toAddress = params.toAddress.trim();

    const fail = (error: string, amountSats = 0n): AdapterPayout => {
      const payout: MockPayoutState = {
        payoutId: `mockpo_${randomBytes(12).toString("hex")}`,
        kind: params.kind,
        toAddress,
        amountSats,
        status: "failed",
        timelockBlocksRemaining: undefined,
        txId: undefined,
        error,
        nextStepAt: Number.MAX_SAFE_INTEGER,
        terminalReported: false,
      };
      this.#payouts.set(payout.payoutId, payout);
      return this.#snapshotPayout(payout);
    };

    if (this.#hasPendingExit()) {
      return fail(
        params.kind === "exit"
          ? "an exit is already pending — the vault is being swept"
          : "an exit is sweeping the vault — off-chain funds are locked until it settles",
        params.amountSats ?? 0n,
      );
    }
    if (toAddress.length === 0) return fail("destination address is required");

    if (params.kind === "cooperative") {
      const amount = params.amountSats;
      if (amount === undefined || amount <= 0n) {
        return fail("amountSats is required for cooperative payouts");
      }
      if (amount > this.#offchainSats) {
        return fail(
          `balance ${this.#offchainSats} sats < requested ${amount} sats`,
          amount,
        );
      }
      this.#offchainSats -= amount;
      const payout: MockPayoutState = {
        payoutId: `mockpo_${randomBytes(12).toString("hex")}`,
        kind: "cooperative",
        toAddress,
        amountSats: amount,
        status: "initiated",
        timelockBlocksRemaining: undefined,
        txId: undefined,
        error: undefined,
        nextStepAt: now + COOPERATIVE_STEP_MS,
        terminalReported: false,
      };
      this.#payouts.set(payout.payoutId, payout);
      return this.#snapshotPayout(payout);
    }

    // Unilateral exit: sweeps the entire off-chain balance. Debited at
    // initiation — those funds are committed to the exit tx from here on.
    if (this.#offchainSats <= 0n) return fail("nothing to exit — off-chain balance is zero");
    const amount = this.#offchainSats;
    this.#offchainSats = 0n;
    const payout: MockPayoutState = {
      payoutId: `mockpo_${randomBytes(12).toString("hex")}`,
      kind: "exit",
      toAddress,
      amountSats: amount,
      status: "initiated",
      timelockBlocksRemaining: EXIT_TIMELOCK_BLOCKS,
      txId: undefined,
      error: undefined,
      nextStepAt: now + EXIT_BLOCK_MS,
      terminalReported: false,
    };
    this.#payouts.set(payout.payoutId, payout);
    return this.#snapshotPayout(payout);
  }

  async pollPayouts(): Promise<AdapterPayout[]> {
    this.#assertInitialized();
    this.#promotePayouts();

    const out: AdapterPayout[] = [];
    for (const p of this.#payouts.values()) {
      const terminal = p.status === "settled" || p.status === "failed";
      if (terminal) {
        if (p.terminalReported) continue;
        p.terminalReported = true;
      }
      out.push(this.#snapshotPayout(p));
    }
    return out;
  }

  async close(): Promise<void> {
    this.#initialized = false;
  }

  // ---- test-only surface ----------------------------------------------------

  /**
   * TEST ONLY. Inserts a payment in `seen` state; it flips to `committed` on the
   * first poll that happens at least `mockCommitLatencyMs` later, simulating
   * settlement-layer commit latency.
   */
  simulateIncomingPayment(toAddress: string, amountSats: bigint): IncomingPayment {
    const now = Date.now();
    const payment: MockPayment = {
      paymentId: `mockpay_${randomBytes(12).toString("hex")}`,
      toAddress,
      amountSats,
      observedAt: now,
      status: "seen",
      commitsAt: now + this.#commitLatencyMs,
      committedEventEmitted: false,
    };
    this.#payments.set(payment.paymentId, payment);
    this.#offchainSats += amountSats;
    return this.#append(payment);
  }

  /** TEST ONLY. Force every pending payment to commit on the next poll. */
  forceCommitAll(): void {
    const now = Date.now();
    for (const p of this.#payments.values()) {
      if (p.status === "seen") p.commitsAt = now - 1;
    }
  }

  /**
   * TEST ONLY. Mine `n` mock blocks instantly: each block advances every
   * non-terminal payout one step (cooperative: initiated -> broadcasting ->
   * settled; exit: initiated -> waiting_timelock, then one timelock decrement
   * per block, settling at zero). Tests never sleep.
   */
  advanceBlocks(n: number): void {
    for (let i = 0; i < n; i += 1) {
      for (const p of this.#payouts.values()) {
        this.#stepPayout(p);
        p.nextStepAt = Date.now() + (p.kind === "exit" ? EXIT_BLOCK_MS : COOPERATIVE_STEP_MS);
      }
    }
  }

  // ---- internals ------------------------------------------------------------

  #hasPendingExit(): boolean {
    for (const p of this.#payouts.values()) {
      if (p.kind === "exit" && p.status !== "settled" && p.status !== "failed") return true;
    }
    return false;
  }

  /** Wall-clock promotion for dev demos; pollPayouts calls this each cycle. */
  #promotePayouts(): void {
    const now = Date.now();
    for (const p of this.#payouts.values()) {
      while (
        p.status !== "settled" &&
        p.status !== "failed" &&
        now >= p.nextStepAt
      ) {
        this.#stepPayout(p);
        p.nextStepAt += p.kind === "exit" ? EXIT_BLOCK_MS : COOPERATIVE_STEP_MS;
      }
    }
  }

  /** One state-machine step for a payout. No-op on terminal states. */
  #stepPayout(p: MockPayoutState): void {
    if (p.kind === "cooperative") {
      if (p.status === "initiated") {
        p.status = "broadcasting";
        p.txId = `mocktx_${randomBytes(16).toString("hex")}`;
      } else if (p.status === "broadcasting") {
        p.status = "settled";
        this.#onchainSats += p.amountSats;
      }
      return;
    }
    // exit
    if (p.status === "initiated") {
      p.status = "waiting_timelock";
      p.txId = `mocktx_${randomBytes(16).toString("hex")}`;
    } else if (p.status === "waiting_timelock") {
      p.timelockBlocksRemaining = Math.max(0, (p.timelockBlocksRemaining ?? 0) - 1);
      if (p.timelockBlocksRemaining === 0) {
        p.status = "settled";
        p.timelockBlocksRemaining = undefined;
        this.#onchainSats += p.amountSats;
      }
    }
  }

  #snapshotPayout(p: MockPayoutState): AdapterPayout {
    const snapshot: AdapterPayout = {
      payoutId: p.payoutId,
      kind: p.kind,
      toAddress: p.toAddress,
      amountSats: p.amountSats,
      status: p.status,
    };
    if (p.timelockBlocksRemaining !== undefined) {
      snapshot.timelockBlocksRemaining = p.timelockBlocksRemaining;
    }
    if (p.txId !== undefined) snapshot.txId = p.txId;
    if (p.error !== undefined) snapshot.error = p.error;
    return snapshot;
  }

  #promoteCommitted(): void {
    const now = Date.now();
    for (const p of this.#payments.values()) {
      if (p.status === "seen" && now >= p.commitsAt) {
        p.status = "committed";
      }
      if (p.status === "committed" && !p.committedEventEmitted) {
        p.committedEventEmitted = true;
        this.#append(p);
      }
    }
  }

  #append(p: MockPayment): IncomingPayment {
    this.#seq += 1;
    const snapshot: IncomingPayment = {
      paymentId: p.paymentId,
      toAddress: p.toAddress,
      amountSats: p.amountSats,
      observedAt: p.observedAt,
      status: p.status,
    };
    this.#events.push({ seq: this.#seq, payment: snapshot });
    return snapshot;
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error("MockTachiAdapter.init() must be awaited before use");
    }
  }
}

function parseCursor(cursor: string | null): number {
  if (cursor === null || cursor === "") return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
