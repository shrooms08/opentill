import { useEffect, useState } from "react";

/** Hash-based routing: `/dashboard#/invoices/inv_x` — no server config needed. */
export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

export function navigate(to: string): void {
  window.location.hash = to;
}
