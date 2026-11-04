import { createContext, useContext } from "react";
import type { ExplorerLinks } from "@opentill/shared";

/**
 * What the dashboard knows about the settlement layer, from GET /healthz.
 * Defaults to "unknown" so views render (without links) before it loads.
 */
export interface SettlementInfo {
  adapterMode: string | null;
  explorer: ExplorerLinks | null;
  demoUrl: string | null;
}

export const SettlementContext = createContext<SettlementInfo>({
  adapterMode: null,
  explorer: null,
  demoUrl: null,
});

export const useSettlement = (): SettlementInfo => useContext(SettlementContext);
