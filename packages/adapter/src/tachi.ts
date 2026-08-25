/**
 * TachiRealAdapter — real settlement against a Tachi daemon, written against
 * the live responses recorded in docs/tachi-smoke-output.md.
 *
 * What is real (proven on regtest):
 *  - receive addresses: fresh BIP-84 key per invoice, encoded as a P2TR address;
 *  - detection: address-scoped VTXO queries (`getAddressVtxos`) + mempool
 *    (`getMempoolByAddress`) mapped onto OpenTill's seen→committed model;
 *  - refunds (`send`): a plain ledger TRANSFER, broadcast with `broadcastTxSync`
 *    and accepted ONLY when `result.code === 0` AND the tx is seen committed;
 *  - balances: off-chain = sum of ledger balances over our keys; on-chain =
 *    L1 UTXOs at our taproot addresses via the daemon's Bitcoin RPC proxy.
 *
 * What is NOT implemented in real mode (honest boundary, see INTEGRATION.md):
 *  - payouts to L1 (cooperative withdrawal / unilateral exit). Both need an
 *    L1-funded, registered Taurus vault (createVault → depositToVault →
 *    registerVault) plus the refund-cosign / exit PSBT flows; the ledger→L1
 *    `TxWithdraw` type exists on the wire but the SDK ships no builder for it.
 *    initiatePayout therefore returns a `failed` payout that says so.
 */
import type { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { getAccountNonce, waitForTachiTxCommit } from "@tachibtc/taurus-vault-core";
import { assertBroadcastOk, makeClient, TachiBroadcastError } from "./tachi/client";
import { MerchantKeyring, type DerivedKey } from "./tachi/keys";
import { StateStore } from "./tachi/state";
import { buildSignedTransferHex, vtxoIdFor } from "./tachi/tx";
import {
  InsufficientFundsError,
  NotImplementedError,
  type AdapterPayout,
  type IncomingPayment,
  type PayoutKind,
  type TachiAdapter,
  type TachiAdapterConfig,
} from "./types";

export { TachiBroadcastError } from "./tachi/client";
export { MerchantKeyring } from "./tachi/keys";
export { buildSignedTransferHex, vtxoIdFor } from "./tachi/tx";

/** Injectable seams so unit tests can run without a daemon. */
export interface TachiRealAdapterDeps {
  client?: TachiClient;
  nonce?: (xOnly: Buffer) => Promise<bigint>;
  waitCommit?: (hash: string) => Promise<{ committed: boolean; code: number; log: string }>;
  now?: () => number;
}

const BALANCE_CACHE_MS = 5_000;
const L1_CACHE_MS = 60_000;
const COMMIT_TIMEOUT_MS = 90_000;

export class TachiRealAdapter implements TachiAdapter {
  readonly mode = "tachi" as const;

  readonly #cfg: TachiAdapterConfig;
  readonly #client: TachiClient;
  readonly #nonce: (xOnly: Buffer) => Promise<bigint>;
  readonly #waitCommit: (hash: string) => Promise<{ committed: boolean; code: number; log: string }>;
  readonly #now: () => number;
  readonly #log: (msg: string, meta?: Record<string, unknown>) => void;

  #keyring: MerchantKeyring | null = null;
  #state: StateStore | null = null;
  #offchainCache: { at: number; value: bigint } | null = null;
  #onchainCache: { at: number; value: bigint } | null = null;
  #l1Warned = false;

  constructor(cfg: TachiAdapterConfig, deps: TachiRealAdapterDeps = {}) {
    if (!cfg?.mnemonic) throw new Error("TachiRealAdapter: tachi.mnemonic is required (TACHI_MNEMONIC)");
    if (!cfg.rpcUrl) throw new Error("TachiRealAdapter: tachi.rpcUrl is required (TACHI_RPC_URL)");
    this.#cfg = cfg;
    this.#client = deps.client ?? makeClient(cfg.rpcUrl, cfg.apiKey);
    this.#nonce = deps.nonce ?? ((xOnly) => getAccountNonce(xOnly, { baseUrl: cfg.rpcUrl }));
    this.#waitCommit =
      deps.waitCommit ??
      (async (hash) => {
        const st = await waitForTachiTxCommit(hash, { baseUrl: cfg.rpcUrl, overallTimeoutMs: COMMIT_TIMEOUT_MS });
        return { committed: st.committed, code: st.code, log: st.log };
      });
    this.#now = deps.now ?? (() => Date.now());
    this.#log = cfg.log ?? (() => {});
  }

  // ---- lifecycle ------------------------------------------------------------

  async init(): Promise<void> {
    this.#keyring = await MerchantKeyring.fromMnemonic(this.#cfg.mnemonic, this.#cfg.network);
    this.#state = new StateStore(this.#cfg.statePath, this.#cfg.network);

    // The "till" key (receive chain, index 0): the merchant's float. Refunds
    // are paid from whichever key can cover amount + fee; a funded till key
    // keeps refunds working even when an invoice key holds exactly its amount.
    const till = this.#keyring.derive(0, false);
    if (!this.#state.findByAddress(till.address)) {
      this.#state.update((s) => s.keys.unshift(till));
    }

    const health = await this.#client.getHealth();
    const status = await this.#client.getStatus();
    const chainId = String((status as any)?.result?.node_info?.network ?? "");
    const height = Number((status as any)?.result?.sync_info?.latest_block_height ?? NaN);
    const catchingUp = Boolean((status as any)?.result?.sync_info?.catching_up);
    if (!chainId.startsWith(`tachi-${this.#cfg.network}`)) {
      throw new Error(
        `TACHI_NETWORK=${this.#cfg.network} but the daemon at ${this.#cfg.rpcUrl} reports chain "${chainId}" — refusing to boot`,
      );
    }
    this.#log("tachi: connected", {
      rpcUrl: this.#cfg.rpcUrl,
      chainId,
      height,
      catchingUp,
      validators: health.validators,
      tillAddress: till.address,
      keys: this.#state.state.keys.length,
      watched: this.#state.state.watched.length,
      statePath: this.#cfg.statePath,
    });
  }

  async close(): Promise<void> {
    /* stateless HTTP client; nothing to release */
  }

  // ---- receiving -----------------------------------------------------------

  async createReceiveAddress(_ref: string): Promise<{ address: string }> {
    const { keyring, state } = this.#ready();
    const index = state.state.nextInvoiceIndex;
    const key = keyring.derive(index, true); // change chain = invoice keys
    state.update((s) => {
      s.nextInvoiceIndex = index + 1;
      s.keys.push(key);
    });
    return { address: key.address };
  }

  async watchAddress(address: string): Promise<void> {
    const { state } = this.#ready();
    if (!state.findByAddress(address)) throw new Error(`watchAddress: ${address} is not one of our keys`);
    state.update((s) => {
      if (!s.watched.includes(address)) s.watched.push(address);
    });
  }

  async unwatchAddress(address: string): Promise<void> {
    const { state } = this.#ready();
    state.update((s) => {
      s.watched = s.watched.filter((a) => a !== address);
    });
  }

  /**
   * Cursor = a ledger height watermark. Committed VTXOs are reported when their
   * commit height is above the cursor; pending mempool credits are reported as
   * `seen` every tick until they commit (the gateway is idempotent on
   * (paymentId, status)). The next cursor is the daemon height read at the START
   * of the tick minus one, so a block committing mid-tick can never be skipped.
   */
  async pollIncoming(cursor: string | null): Promise<{ payments: IncomingPayment[]; nextCursor: string }> {
    const { state } = this.#ready();
    const from = parseCursor(cursor);
    const status = await this.#client.getStatus();
    const h0 = Number((status as any)?.result?.sync_info?.latest_block_height ?? NaN);
    const now = this.#now();
    const payments: IncomingPayment[] = [];

    for (const address of state.state.watched) {
      const key = state.findByAddress(address);
      if (!key) continue;

      const mempool = await this.#client.getMempoolByAddress(address);
      for (const tx of mempool.transactions ?? []) {
        tx.vout.forEach((out, i) => {
          if (out.owner.toLowerCase() !== key.xOnlyHex) return;
          payments.push({
            paymentId: vtxoIdFor(tx.tx_hash, i),
            toAddress: address,
            amountSats: BigInt(out.amount),
            observedAt: now,
            status: "seen",
          });
        });
      }

      const committed = await this.#client.getAddressVtxos(address, true);
      for (const v of committed.vtxos) {
        if (v.height <= from) continue;
        payments.push({
          paymentId: v.id,
          toAddress: address,
          amountSats: BigInt(v.amount),
          observedAt: now,
          status: "committed",
        });
      }
    }

    const nextCursor = Number.isFinite(h0) ? Math.max(from, h0 - 1) : from;
    return { payments, nextCursor: String(nextCursor) };
  }

  // ---- sending (refunds) ---------------------------------------------------

  async send(params: { toAddress: string; amountSats: bigint; ref: string }): Promise<{ txId: string }> {
    const { keyring, state } = this.#ready();
    if (params.amountSats <= 0n) throw new RangeError("send amount must be positive");
    const owner = keyring.ownerFromAddress(params.toAddress);
    const fee = await this.#feeSats();
    const need = params.amountSats + fee;

    // One TachiTx has one signer, so pick a single key that can cover amount+fee
    // (smallest sufficient balance first — leaves the float intact when possible).
    const funded: Array<{ key: DerivedKey; vtxos: Array<{ id: string; amount: number }>; total: bigint }> = [];
    for (const key of state.state.keys) {
      const res = await this.#client.getAddressVtxos(key.address, false);
      const spendable = res.vtxos.filter((v) => !v.spent && !v.locked);
      const total = spendable.reduce((a, v) => a + BigInt(v.amount), 0n);
      if (total > 0n) funded.push({ key, vtxos: spendable.map((v) => ({ id: v.id, amount: v.amount })), total });
    }
    const pick = funded.filter((f) => f.total >= need).sort((a, b) => (a.total < b.total ? -1 : 1))[0];
    if (!pick) {
      const grand = funded.reduce((a, f) => a + f.total, 0n);
      throw new InsufficientFundsError(
        `no single key can cover ${params.amountSats} + fee ${fee} sats (largest key ${funded.map((f) => f.total).sort((a, b) => (a < b ? 1 : -1))[0] ?? 0n}, total ${grand} across ${funded.length} keys) — fund the till key`,
      );
    }

    // Largest-first input selection within the chosen key.
    const inputs: Array<{ vtxoId: string; valueSats: bigint }> = [];
    let inSum = 0n;
    for (const v of [...pick.vtxos].sort((a, b) => b.amount - a.amount)) {
      inputs.push({ vtxoId: v.id, valueSats: BigInt(v.amount) });
      inSum += BigInt(v.amount);
      if (inSum >= need) break;
    }
    const change = inSum - need;
    const outputs = [{ owner, amountSats: params.amountSats }];
    if (change > 0n) outputs.push({ owner: Buffer.from(pick.key.xOnlyHex, "hex"), amountSats: change });

    const nonce = await this.#nonce(Buffer.from(pick.key.xOnlyHex, "hex"));
    const hex = await buildSignedTransferHex({
      signer: keyring.signer(pick.key),
      spenderXOnly: Buffer.from(pick.key.xOnlyHex, "hex"),
      inputs,
      outputs,
      feeSats: fee,
      nonce,
    });

    // A resolved promise is NOT success: read the CometBFT verdict, then wait
    // for the block commit — a mempool accept can still be dropped later.
    const verdict = assertBroadcastOk(await this.#client.broadcastTxSync(hex));
    const commit = await this.#waitCommit(verdict.hash);
    if (!commit.committed) throw new TachiBroadcastError(commit.code, commit.log || "not committed");

    this.#offchainCache = null;
    this.#log("tachi: transfer committed", { txId: verdict.hash, from: pick.key.address, to: params.toAddress, amountSats: params.amountSats.toString(), fee: fee.toString(), ref: params.ref });
    return { txId: verdict.hash };
  }

  // ---- balances ------------------------------------------------------------

  async getBalance(): Promise<{ offchainSats: bigint; onchainSats: bigint }> {
    const { state } = this.#ready();
    const now = this.#now();

    if (!this.#offchainCache || now - this.#offchainCache.at > BALANCE_CACHE_MS) {
      let sum = 0n;
      for (const key of state.state.keys) {
        const b = await this.#client.getBalance(key.address);
        sum += BigInt(b.balance_sat);
      }
      this.#offchainCache = { at: now, value: sum };
    }

    if (!this.#onchainCache || now - this.#onchainCache.at > L1_CACHE_MS) {
      let sats = 0n;
      try {
        const descriptors = state.state.keys.map((k) => `addr(${k.address})`);
        const r = await this.#client.bitcoinRPC({ method: "scantxoutset", params: ["start", descriptors] });
        if (r.error) throw new Error(`${r.error.code} ${r.error.message}`);
        const total = (r.result as { total_amount?: number })?.total_amount ?? 0;
        sats = BigInt(Math.round(total * 1e8));
      } catch (err) {
        if (!this.#l1Warned) {
          this.#l1Warned = true;
          this.#log("tachi: on-chain balance unavailable (scantxoutset via proxy)", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.#onchainCache = { at: now, value: sats };
    }

    return { offchainSats: this.#offchainCache.value, onchainSats: this.#onchainCache.value };
  }

  // ---- payouts (not implemented in real mode) --------------------------------

  async initiatePayout(params: { kind: PayoutKind; toAddress: string; amountSats?: bigint }): Promise<AdapterPayout> {
    const why =
      params.kind === "exit"
        ? "unilateral exit needs an L1-funded, registered Taurus vault (buildUnilateralExitPsbt spends the vault's exit leaf); this deployment holds ledger VTXOs, not a vault"
        : "cooperative withdrawal to L1 needs a registered Taurus vault + the refund co-sign flow (or the wire-level TxWithdraw, for which the SDK ships no builder)";
    return {
      payoutId: `unimpl_${this.#now().toString(36)}`,
      kind: params.kind,
      toAddress: params.toAddress,
      amountSats: params.amountSats ?? 0n,
      status: "failed",
      error: `not implemented in real (tachi) mode: ${why} — see INTEGRATION.md`,
    };
  }

  async pollPayouts(): Promise<AdapterPayout[]> {
    return [];
  }

  /** Exposed for scripts/tests: the adapter's keys (public material only). */
  keys(): readonly DerivedKey[] {
    return this.#ready().state.state.keys;
  }

  // ---- internals ------------------------------------------------------------

  #ready(): { keyring: MerchantKeyring; state: StateStore } {
    if (!this.#keyring || !this.#state) throw new NotImplementedError("TachiRealAdapter.init() must be awaited before use");
    return { keyring: this.#keyring, state: this.#state };
  }

  async #feeSats(): Promise<bigint> {
    try {
      const est = await this.#client.getFeeEstimate();
      return BigInt(Math.max(1, est.recommended_fee_sat || est.min_fee_sat || 1));
    } catch {
      return 1n;
    }
  }
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
