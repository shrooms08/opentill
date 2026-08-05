import { useEffect, useState } from "react";
import type { PublicInvoice } from "./types";

export interface InvoiceFeed {
  invoice: PublicInvoice | null;
  notFound: boolean;
}

const POLL_FALLBACK_MS = 5_000;

/**
 * Live invoice state: one snapshot fetch (which also detects 404 — EventSource
 * can't surface status codes), then SSE. If the stream errors, a 5s polling
 * loop covers the gap while EventSource retries; the first event or `open`
 * stops it again.
 */
export function useInvoice(invoiceId: string): InvoiceFeed {
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!invoiceId) {
      setNotFound(true);
      return;
    }

    let stopped = false;
    let source: EventSource | null = null;
    let pollTimer: number | null = null;

    const fetchOnce = async (): Promise<"ok" | "missing" | "error"> => {
      try {
        const res = await fetch(`/pay/api/${invoiceId}`, {
          headers: { accept: "application/json" },
        });
        if (res.status === 404) {
          if (!stopped) setNotFound(true);
          return "missing";
        }
        if (!res.ok) return "error";
        const body = (await res.json()) as PublicInvoice;
        if (!stopped) setInvoice(body);
        return "ok";
      } catch {
        return "error";
      }
    };

    const stopPolling = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startPolling = () => {
      if (pollTimer !== null || stopped) return;
      pollTimer = window.setInterval(() => void fetchOnce(), POLL_FALLBACK_MS);
    };

    void (async () => {
      const first = await fetchOnce();
      if (stopped || first === "missing") return;
      if (first === "error") startPolling();

      source = new EventSource(`/pay/api/${invoiceId}/events`);
      source.addEventListener("status", (event) => {
        stopPolling();
        if (!stopped) setInvoice(JSON.parse((event as MessageEvent).data) as PublicInvoice);
      });
      source.onopen = () => stopPolling();
      source.onerror = () => startPolling();
    })();

    return () => {
      stopped = true;
      stopPolling();
      source?.close();
    };
  }, [invoiceId]);

  return { invoice, notFound };
}
