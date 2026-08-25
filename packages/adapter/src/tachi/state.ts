/**
 * Durable adapter state: which keys have been handed out (so spends can be
 * signed and balances summed after a restart) and which addresses are watched.
 * One small JSON file (`TACHI_STATE_PATH`), written atomically (tmp + rename).
 * Everything in it is re-derivable from the mnemonic; it is an index, not a secret.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DerivedKey } from "./keys";

export interface TachiAdapterState {
  version: 1;
  network: string;
  /** Next change-chain index to hand out for an invoice. */
  nextInvoiceIndex: number;
  keys: DerivedKey[];
  /** Addresses the poller cares about (persisted so restarts keep detecting). */
  watched: string[];
}

export class StateStore {
  readonly #path: string;
  #state: TachiAdapterState;

  constructor(path: string, network: string) {
    this.#path = path;
    this.#state = StateStore.#load(path, network);
  }

  static #load(path: string, network: string): TachiAdapterState {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as TachiAdapterState;
      if (parsed.version !== 1) throw new Error(`unsupported state version ${String(parsed.version)}`);
      if (parsed.network !== network) {
        throw new Error(`state file ${path} is for network "${parsed.network}", adapter is "${network}"`);
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, network, nextInvoiceIndex: 0, keys: [], watched: [] };
      }
      throw err;
    }
  }

  get state(): Readonly<TachiAdapterState> {
    return this.#state;
  }

  update(mutate: (s: TachiAdapterState) => void): void {
    mutate(this.#state);
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#state, null, 2));
    renameSync(tmp, this.#path);
  }

  findByAddress(address: string): DerivedKey | undefined {
    return this.#state.keys.find((k) => k.address === address);
  }
}
