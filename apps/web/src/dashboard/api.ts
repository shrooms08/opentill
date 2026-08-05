import type {
  InvoiceDTO,
  InvoiceStatus,
  PaymentDTO,
  PayoutDTO,
  PayoutKind,
  StatsDTO,
  WebhookDeliveryDTO,
} from "@opentill/shared";

/**
 * The API key lives in sessionStorage only: cleared when the tab closes,
 * never in a URL or cookie, acceptable for a single-merchant self-hosted
 * tool. See the README for the rationale.
 */
const KEY_STORAGE = "opentill.apiKey";

export const UNAUTHORIZED_EVENT = "opentill:unauthorized";

export const getStoredKey = (): string | null => sessionStorage.getItem(KEY_STORAGE);
export const storeKey = (key: string): void => sessionStorage.setItem(KEY_STORAGE, key);
export const clearKey = (): void => sessionStorage.removeItem(KEY_STORAGE);

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${getStoredKey() ?? ""}`,
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "could not reach the gateway");
  }

  if (res.status === 401) {
    // Central 401 handling: drop the key and bounce the app to the prompt.
    clearKey();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(401, "API key rejected");
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface InvoiceListResult {
  invoices: InvoiceDTO[];
  total: number;
  limit: number;
  offset: number;
}

export interface InvoiceWithPayments extends InvoiceDTO {
  payments: PaymentDTO[];
}

export interface Balance {
  offchainSats: string;
  onchainSats: string;
}

export interface Health {
  ok: boolean;
  adapterMode: string;
  dbOk: boolean;
}

export const api = {
  /** No-auth health probe; also reveals whether settlement is mock or real. */
  health: () => request<Health>("/healthz"),
  stats: () => request<StatsDTO>("/api/stats"),
  balance: () => request<Balance>("/api/balance"),

  listInvoices: (opts: {
    status?: InvoiceStatus;
    q?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.q) params.set("q", opts.q);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    return request<InvoiceListResult>(`/api/invoices?${params.toString()}`);
  },

  getInvoice: (id: string) => request<InvoiceWithPayments>(`/api/invoices/${id}`),

  createInvoice: (body: { amountSats: string; memo?: string }) =>
    request<InvoiceDTO>("/api/invoices", { method: "POST", body: JSON.stringify(body) }),

  refund: (id: string, toAddress: string) =>
    request<{ txId: string; invoice: InvoiceDTO }>(`/api/invoices/${id}/refund`, {
      method: "POST",
      body: JSON.stringify({ toAddress }),
    }),

  webhookDeliveries: (invoiceId: string) =>
    request<{ deliveries: WebhookDeliveryDTO[] }>(`/api/invoices/${invoiceId}/webhook-deliveries`),

  retryDelivery: (deliveryId: string) =>
    request<{ delivery: WebhookDeliveryDTO }>(`/api/webhook-deliveries/${deliveryId}/retry`, {
      method: "POST",
      body: "{}",
    }),

  listPayouts: (opts: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    return request<{ payouts: PayoutDTO[]; total: number }>(`/api/payouts?${params.toString()}`);
  },

  createPayout: (body: { kind: PayoutKind; toAddress: string; amountSats?: string }) =>
    request<PayoutDTO>("/api/payouts", { method: "POST", body: JSON.stringify(body) }),
};

/** The exit currently sweeping the vault, if any. */
export function findPendingExit(payouts: PayoutDTO[]): PayoutDTO | null {
  return (
    payouts.find(
      (p) => p.kind === "exit" && p.status !== "settled" && p.status !== "failed",
    ) ?? null
  );
}
