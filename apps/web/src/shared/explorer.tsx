import type { ExplorerLinks } from "@opentill/shared";

/** Fill a `{hash}` / `{address}` link template. */
export function explorerTxUrl(explorer: ExplorerLinks, hash: string): string {
  return explorer.txUrl.replaceAll("{hash}", encodeURIComponent(hash));
}

export function explorerAddressUrl(explorer: ExplorerLinks, address: string): string {
  return explorer.addressUrl.replaceAll("{address}", encodeURIComponent(address));
}

/**
 * Small outbound link to the settlement layer's own view. Renders nothing
 * without explorer config (mock mode), so callers never need to branch.
 */
export function TachiLink({
  explorer,
  txId,
  address,
  label = "View on Tachi ↗",
  className = "tachi-link",
}: {
  explorer: ExplorerLinks | null | undefined;
  txId?: string | null;
  address?: string | null;
  label?: string;
  className?: string;
}) {
  if (!explorer) return null;
  const href = txId ? explorerTxUrl(explorer, txId) : address ? explorerAddressUrl(explorer, address) : null;
  if (!href) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}
