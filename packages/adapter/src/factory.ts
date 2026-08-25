import { MockTachiAdapter } from "./mock";
import { TachiRealAdapter } from "./tachi";
import { type AdapterConfig, type TachiAdapter } from "./types";

/**
 * Single construction point for settlement adapters. Nothing outside this
 * package may know which implementation is in play.
 *
 * `mock` stays the test/demo/CI adapter forever. `tachi` is the real daemon
 * integration and needs `config.tachi` (mnemonic, RPC URL, state path).
 */
export function createAdapter(config: AdapterConfig): TachiAdapter {
  switch (config.mode) {
    case "mock":
      return new MockTachiAdapter(config);
    case "tachi":
      if (!config.tachi) {
        throw new Error("ADAPTER_MODE=tachi requires tachi settings (TACHI_MNEMONIC, TACHI_RPC_URL) — see README");
      }
      return new TachiRealAdapter(config.tachi);
    default: {
      const exhaustive: never = config.mode;
      throw new Error(`unknown adapter mode: ${String(exhaustive)}`);
    }
  }
}
