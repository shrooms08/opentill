/**
 * TachiRealAdapter — documentation-as-code scaffold for the real Tachi
 * settlement integration.
 *
 * This file COMPILES WITHOUT the @tachibtc/* packages installed. It is written
 * for two audiences:
 *   1. The Tachi team, as a precise statement of what OpenTill needs from the
 *      SDK and exactly where the devnet is currently blocking us.
 *   2. Whoever wires the real integration once those questions are answered —
 *      each method already contains the step-by-step calls it will make.
 *
 * Nothing here runs today: `init()` throws immediately with a pointer to
 * INTEGRATION.md, and the factory only reaches this class when someone sets
 * ADAPTER_MODE=tachi. The method bodies are the integration spec.
 *
 * The local interfaces below MIRROR the documented @tachibtc/* surface per
 * docs.tachibtc.com as recorded in INTEGRATION.md. They are UNVERIFIED against
 * the real packages (the GitHub Packages token and package availability are
 * unconfirmed) — treat every signature as "as documented, subject to change".
 */

import {
  NotImplementedError,
  type AdapterConfig,
  type AdapterPayout,
  type IncomingPayment,
  type PayoutKind,
  type TachiAdapter,
} from "./types";

// ===========================================================================
// Local mirror of the documented Tachi SDK surface (UNVERIFIED)
// Mirrors @tachibtc/daemon-client and @tachibtc/vault-core per docs.tachibtc.com.
// ===========================================================================

/** A P2TR vault address plus the taproot tree that governs its exit. */
interface TachiVault {
  vaultId: string;
  address: string;
  /** Block height delta for the unilateral-exit timelock leaf. */
  exitTimelockBlocks: number;
}

/** A VTXO — an off-chain output spendable inside the vault, backed on-chain. */
interface Vtxo {
  vtxoId: string;
  vaultId: string;
  amountSats: bigint;
  /** "pending" = seen but not co-signed; "committed" = quorum co-signed. */
  state: "pending" | "committed" | "spent";
  createdAt: number;
}

/** Mirrors @tachibtc/daemon-client — RPC to a local tachid instance. */
interface TachiDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Current chain tip; drives exit timelock countdowns. */
  getBlockHeight(): Promise<number>;
  /** Confirmed on-chain balance held by the daemon's wallet. */
  getOnchainBalanceSats(): Promise<bigint>;
  /** Broadcast a fully-signed transaction to the Bitcoin network. */
  broadcastTx(txHex: string): Promise<{ txId: string }>;
}

/** Mirrors @tachibtc/vault-core — vault + VTXO construction/signing. */
interface TachiVaultCore {
  /** Create (or address-derive within) a vault. Needs the validator set. */
  createVault(params: { validatorSet: ValidatorSetHandle }): Promise<TachiVault>;
  /** Deposit on-chain funds into the vault, producing the initial VTXO set. */
  depositToVault(params: { vaultId: string; amountSats: bigint }): Promise<Vtxo>;
  /** Enumerate VTXOs currently credited to a vault address. */
  listVtxos(params: { address: string; sinceCursor: string | null }): Promise<{
    vtxos: Vtxo[];
    nextCursor: string;
  }>;
  /** Build the PSBT that spends a VTXO out cooperatively (needs co-signers). */
  buildVtxoPsbt(params: { fromVaultId: string; toAddress: string; amountSats: bigint }): Promise<Psbt>;
  /** Local verification of a PSBT before we ask anyone to sign it. */
  verifyVtxoPsbt(psbt: Psbt): Promise<{ ok: boolean; reason?: string }>;
  /** Attach OUR signature to the PSBT. */
  signVtxoPsbt(psbt: Psbt): Promise<Psbt>;
  /** Combine all required signatures once the quorum has co-signed. */
  finalizeVtxoPsbt(psbt: Psbt): Promise<{ txHex: string }>;
  /** Build the unilateral-exit transaction from the vault's exit leaf. */
  buildExitPsbt(params: { vaultId: string; toAddress: string }): Promise<Psbt>;
  /** Resolve once a VTXO reaches the co-signed `committed` state. */
  waitForVtxoCommit(vtxoId: string): Promise<Vtxo>;
}

/** Opaque PSBT handle in the mirrored surface. */
interface Psbt {
  base64: string;
}

/** Handle to the devnet validator set / KDHT. Acquisition is Q3 (blocked). */
interface ValidatorSetHandle {
  readonly quorumSize: number;
}

// The real module bindings would be:
//   import { createDaemonClient } from "@tachibtc/daemon-client";
//   import { createVaultCore } from "@tachibtc/vault-core";
// They are intentionally NOT imported or installed here.

// ===========================================================================
// Blocking markers — the three open devnet questions
// ===========================================================================

export type BlockedQuestion =
  | "Q1-cosign-trigger"
  | "Q2-receiver-detection"
  | "Q3-validator-access";

/** Thrown at each step the devnet has not yet unblocked. */
export class TachiIntegrationBlocked extends Error {
  readonly questionId: BlockedQuestion;
  constructor(questionId: BlockedQuestion, message: string) {
    super(`[${questionId}] ${message} — see INTEGRATION.md`);
    this.name = "TachiIntegrationBlocked";
    this.questionId = questionId;
  }
}

/** Documentation marker: this line is blocked on an open devnet question. */
function BLOCKED(questionId: BlockedQuestion, message: string): never {
  throw new TachiIntegrationBlocked(questionId, message);
}

// ===========================================================================
// The adapter
// ===========================================================================

/**
 * Implements the same `TachiAdapter` contract the mock does, so the entire
 * gateway, poller, webhook, and test suite run against it unchanged once the
 * three blocked sections are filled in.
 */
export class TachiRealAdapter implements TachiAdapter {
  readonly mode = "tachi" as const;

  // These are the SDK handles the method walkthroughs assume. They stay null
  // because init() throws before wiring them.
  #daemon: TachiDaemonClient | null = null;
  #vaultCore: TachiVaultCore | null = null;
  #vault: TachiVault | null = null;

  constructor(private readonly config: AdapterConfig) {
    void this.config;
  }

  /**
   * Real init would: create the daemon client, connect(), create/derive the
   * merchant vault. It refuses to run today — ADAPTER_MODE=tachi is a spec,
   * not a live path.
   */
  async init(): Promise<void> {
    // Connects to Tachi's HOSTED regtest/Signet RPC (not a local bitcoind — a
    // local regtest chain will not work against their private node):
    // const { createDaemonClient } = await import("@tachibtc/daemon-client");
    // const { createVaultCore } = await import("@tachibtc/vault-core");
    // this.#daemon = createDaemonClient({ url: hostedRpcUrl /* ... */ });
    // await this.#daemon.connect();
    // this.#vaultCore = createVaultCore({ daemon: this.#daemon });
    // this.#vault = await this.#vaultCore.createVault({ validatorSet });  // ← Q3 endpoint pending
    throw new NotImplementedError(
      "ADAPTER_MODE=tachi is a documented integration scaffold, not a live adapter. " +
        "As of 2026-07-22: co-signing is answered (node co-signs on broadcast); vault " +
        "creation runs against Tachi's hosted node; receiver-side VTXO detection is still " +
        "open. It waits on Tachi's published RPC endpoints. See INTEGRATION.md for the " +
        "method-by-method mapping and the swap-in plan. Run with ADAPTER_MODE=mock.",
    );
  }

  /**
   * Derive a fresh receive address inside the merchant vault.
   *
   * Steps: ensure a vault exists (init), then derive/allocate a receive
   * address under it. Q3 is PARTIALLY ANSWERED — there is no local validator
   * set to obtain; the vault is created against Tachi's HOSTED regtest/Signet
   * node. The concrete createVault endpoint is pending Tachi's Swagger.
   */
  async createReceiveAddress(_ref: string): Promise<{ address: string }> {
    // A vault is created against the hosted node (not a local validator set):
    //   const vault = await this.#vaultCore!.createVault({ validatorSet });
    //   return { address: vault.address };
    return BLOCKED(
      "Q3-validator-access",
      "vault creation runs against Tachi's hosted node (no local validator set); " +
        "the createVault endpoint is pending Tachi Swagger",
    );
  }

  /**
   * Poll for incoming VTXOs to watched vault addresses and report each as a
   * payment, mapping VTXO state → our seen/committed model:
   *   pending   → "seen"       (arrived, not yet co-signed)
   *   committed → "committed"  (quorum co-signed; safe to confirm the invoice)
   *
   * Detecting the incoming VTXO in the first place is the blocked step (Q2).
   * Once detection works, the pending→committed transition follows for free:
   * Q1 is answered — the node co-signs on broadcast — so a VTXO's committed
   * state is observable via `waitForVtxoCommit` with no quorum round to drive.
   */
  async pollIncoming(
    _cursor: string | null,
  ): Promise<{ payments: IncomingPayment[]; nextCursor: string }> {
    // const { vtxos, nextCursor } = await this.#vaultCore!.listVtxos({
    //   address: watchedAddress,
    //   sinceCursor: _cursor,
    // });
    // const payments = vtxos.map((v) => ({
    //   paymentId: v.vtxoId,
    //   toAddress: this.#vault!.address,
    //   amountSats: v.amountSats,
    //   observedAt: v.createdAt,
    //   status: v.state === "committed" ? "committed" : "seen",
    // }));
    // return { payments, nextCursor };
    return BLOCKED(
      "Q2-receiver-detection",
      "no documented receiver-side path to detect an incoming VTXO to a vault " +
        "address we control; docs cover sending, not receiving",
    );
  }

  async watchAddress(_address: string): Promise<void> {
    // Register the address with the daemon's VTXO subscription so listVtxos /
    // a push feed surfaces payments to it. Implementable once Q2 is answered.
    throw new NotImplementedError("watchAddress: implement alongside pollIncoming (Q2).");
  }

  async unwatchAddress(_address: string): Promise<void> {
    throw new NotImplementedError("unwatchAddress: implement alongside pollIncoming (Q2).");
  }

  /**
   * Send sats out for a refund. This is a cooperative spend of committed
   * VTXOs, so it walks the same build → verify → sign → broadcast path as a
   * cooperative payout. Q1 is ANSWERED — the node co-signs on broadcast — so
   * this is specification-complete; it waits only on the published broadcast
   * endpoint. Not separately BLOCKED — see initiatePayout's cooperative branch
   * for the single Q1 marker.
   */
  async send(_params: {
    toAddress: string;
    amountSats: bigint;
    ref: string;
  }): Promise<{ txId: string }> {
    // const psbt = await this.#vaultCore!.buildVtxoPsbt({ ... });
    // await this.#vaultCore!.verifyVtxoPsbt(psbt);
    // const mine = await this.#vaultCore!.signVtxoPsbt(psbt);
    // return this.#daemon!.broadcastTx(mine.base64); // node co-signs on broadcast (Q1)
    throw new NotImplementedError(
      "send (refund): cooperative spend; Q1 answered (node co-signs on broadcast), " +
        "pending the published broadcast endpoint. See INTEGRATION.md.",
    );
  }

  async getBalance(): Promise<{ offchainSats: bigint; onchainSats: bigint }> {
    // offchain = sum of committed VTXO amounts in the vault;
    // onchain  = this.#daemon!.getOnchainBalanceSats().
    throw new NotImplementedError(
      "getBalance: sum committed VTXOs (needs Q2 detection) + daemon on-chain balance.",
    );
  }

  /**
   * Start a withdrawal to on-chain Bitcoin.
   *
   * - cooperative: build the spend PSBT, sign our part, and broadcast — the
   *   node co-signs automatically on broadcast (Q1 answered). The remaining
   *   blocker is the published broadcast endpoint, not the mechanism.
   * - exit: broadcast the vault's exit leaf unilaterally — no quorum, just a
   *   timelock. Fully implementable once a vault exists (Q3); no co-sign
   *   needed, which is the whole point of the exit path.
   */
  async initiatePayout(params: {
    kind: PayoutKind;
    toAddress: string;
    amountSats?: bigint;
  }): Promise<AdapterPayout> {
    if (params.kind === "cooperative") {
      // Q1 ANSWERED (2026-07-22): the Tachi node co-signs automatically on
      // broadcast — there is no quorum round to drive and no separate signing
      // endpoint. We build, sign our part, and broadcast; the node co-signs as
      // it accepts the broadcast.
      // const psbt = await this.#vaultCore!.buildVtxoPsbt({
      //   fromVaultId: this.#vault!.vaultId,
      //   toAddress: params.toAddress,
      //   amountSats: params.amountSats!,
      // });
      // const mine = await this.#vaultCore!.signVtxoPsbt(psbt);
      // const { txId } = await this.#daemon!.broadcastTx(mine.base64); // node co-signs on broadcast
      return BLOCKED(
        "Q1-cosign-trigger",
        "co-signing is ANSWERED (the node co-signs automatically on broadcast); " +
          "remaining blocker is the published broadcast RPC endpoint, pending Tachi Swagger",
      );
    }

    // Unilateral exit — the sovereignty path. Implementable without any
    // validator once the vault exists:
    //   const psbt = await this.#vaultCore!.buildExitPsbt({
    //     vaultId: this.#vault!.vaultId, toAddress: params.toAddress });
    //   const signed = await this.#vaultCore!.signVtxoPsbt(psbt);
    //   const { txHex } = await this.#vaultCore!.finalizeVtxoPsbt(signed);
    //   const { txId } = await this.#daemon!.broadcastTx(txHex);
    //   // then track timelockBlocksRemaining via getBlockHeight() until spendable.
    throw new NotImplementedError(
      "initiatePayout(exit): implementable once a vault exists (Q3); broadcasts the " +
        "exit leaf with no co-signers. See INTEGRATION.md.",
    );
  }

  async pollPayouts(): Promise<AdapterPayout[]> {
    // For cooperative payouts: poll the broadcast tx to confirmation.
    // For exits: recompute timelockBlocksRemaining from getBlockHeight() and
    // flip to "settled" once the exit output is spendable and swept on-chain.
    throw new NotImplementedError(
      "pollPayouts: track cooperative tx confirmation + exit timelock via daemon block height.",
    );
  }

  async close(): Promise<void> {
    await this.#daemon?.close();
  }
}
