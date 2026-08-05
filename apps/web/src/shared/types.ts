// Type-only import: the shared workspace package never reaches the bundle.
import type { PublicInvoiceDTO } from "@opentill/shared";

/** Wire shape of GET /pay/api/:invoiceId and every SSE `status` event. */
export type PublicInvoice = PublicInvoiceDTO;
