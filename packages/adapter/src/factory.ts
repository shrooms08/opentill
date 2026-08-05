import { MockTachiAdapter } from "./mock";
import { TachiRealAdapter } from "./tachi";
import { type AdapterConfig, type TachiAdapter } from "./types";

/**
 * Single construction point for settlement adapters. Nothing outside this
 * package may know which implementation is in play.
 *
 * `tachi` mode constructs the real adapter scaffold; it constructs fine but
 * `init()` throws with a pointer to INTEGRATION.md (three devnet questions
 * still block the live integration).
 */
export function createAdapter(config: AdapterConfig): TachiAdapter {
  switch (config.mode) {
    case "mock":
      return new MockTachiAdapter(config);
    case "tachi":
      return new TachiRealAdapter(config);
    default: {
      const exhaustive: never = config.mode;
      throw new Error(`unknown adapter mode: ${String(exhaustive)}`);
    }
  }
}
