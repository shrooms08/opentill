/**
 * Merchant key management for the real Tachi adapter.
 *
 * Model (verified in docs/tachi-smoke-output.md): a Tachi ledger VTXO is owned
 * by a 32-byte x-only secp256k1 key. A "receive address" is that key encoded as
 * a bech32m P2TR output key (bcrt1p… / tb1p… / bc1p…), which the daemon and
 * `xOnlyFromAddress` decode straight back to the owner key. Nothing on L1 is
 * involved in receiving.
 *
 * All keys derive from one BIP-39 mnemonic (`TACHI_MNEMONIC`) along BIP-84
 * paths via the SDK's own `deriveUserKey` (so the descriptors are the ones
 * Tachi's tooling would reproduce):
 *   - receive chain, index 0        → the merchant "till" key (float for refunds)
 *   - change chain,  index 0,1,2…   → one fresh key per invoice
 */
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory, type BIP32Interface } from "bip32";
import * as bip39 from "bip39";
import {
  deriveUserKey,
  normalizeTaprootSigner,
  resolveWalletNetwork,
  xOnlyFromAddress,
  type TaprootSigner,
} from "@tachibtc/taurus-vault-core";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

export type TachiNetwork = "regtest" | "signet";

export interface DerivedKey {
  readonly index: number;
  /** false = receive chain (till/operator keys); true = change chain (invoice keys). */
  readonly change: boolean;
  readonly path: string;
  /** 32-byte x-only owner key (hex). This is what the ledger keys ownership on. */
  readonly xOnlyHex: string;
  /** bech32m P2TR encoding of the x-only key — the customer-facing address. */
  readonly address: string;
}

export function bitcoinNetwork(network: TachiNetwork): bitcoin.Network {
  return network === "signet" ? bitcoin.networks.testnet : bitcoin.networks.regtest;
}

export class MerchantKeyring {
  readonly #root: BIP32Interface;
  readonly #mnemonic: string;
  readonly network: TachiNetwork;
  readonly #btc: bitcoin.Network;

  private constructor(mnemonic: string, root: BIP32Interface, network: TachiNetwork) {
    this.#mnemonic = mnemonic;
    this.#root = root;
    this.network = network;
    this.#btc = bitcoinNetwork(network);
  }

  static async fromMnemonic(mnemonic: string, network: TachiNetwork): Promise<MerchantKeyring> {
    const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
    if (!bip39.validateMnemonic(normalized)) {
      throw new Error("TACHI_MNEMONIC is not a valid BIP-39 mnemonic");
    }
    const seed = await bip39.mnemonicToSeed(normalized);
    return new MerchantKeyring(normalized, bip32.fromSeed(seed, bitcoinNetwork(network)), network);
  }

  /** Public material for a key; deterministic, safe to call repeatedly. */
  derive(index: number, change: boolean): DerivedKey {
    const descriptor = deriveUserKey(this.#mnemonic, resolveWalletNetwork(this.network), { index, change });
    const node = this.#root.derivePath(descriptor.path);
    const xOnly = Buffer.from(node.publicKey).subarray(1, 33);
    const address = bitcoin.payments.p2tr({ pubkey: xOnly, network: this.#btc }).address;
    if (!address || !xOnlyFromAddress(address, this.#btc).equals(xOnly)) {
      throw new Error(`taproot address round-trip failed for ${descriptor.path}`);
    }
    return { index, change, path: descriptor.path, xOnlyHex: xOnly.toString("hex"), address };
  }

  /** Schnorr signer for a key (BIP-340 over the TachiTx sighash). */
  signer(key: Pick<DerivedKey, "path">): TaprootSigner {
    return normalizeTaprootSigner(this.#root.derivePath(key.path));
  }

  /** Decode any taproot address / x-only hex on this network to the owner key. */
  ownerFromAddress(addressOrHex: string): Buffer {
    const s = addressOrHex.trim();
    if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
    if (/^[0-9a-f]{66}$/i.test(s)) return Buffer.from(s, "hex").subarray(1, 33);
    return xOnlyFromAddress(s, this.#btc);
  }
}
