import { z } from "zod";
import { INVOICE_STATUSES } from "./types";
import { MAX_EXPIRY_SECONDS, MIN_EXPIRY_SECONDS } from "./constants";

/** A decimal string of satoshis, > 0. Strings keep us bigint-safe over JSON. */
// zod still evaluates the refinement when the regex check has already failed,
// so the refinement must not assume `v` is BigInt-parsable.
export const satsStringSchema = z
  .string()
  .regex(/^\d+$/, "must be a decimal string of satoshis")
  .refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, "must be greater than zero");

/** http(s) only — this URL is rendered as a link on the public checkout page. */
const httpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

export const createInvoiceSchema = z.object({
  amountSats: satsStringSchema,
  memo: z.string().max(512).optional(),
  orderId: z.string().max(128).optional(),
  webhookUrl: z.string().url().max(2048).optional(),
  /** Shown to the customer as "Return to store" on terminal checkout states. */
  returnUrl: httpUrlSchema.optional(),
  expiresInSeconds: z.number().int().min(MIN_EXPIRY_SECONDS).max(MAX_EXPIRY_SECONDS).optional(),
});
export type CreateInvoiceBody = z.infer<typeof createInvoiceSchema>;

export const invoiceIdParamsSchema = z.object({ id: z.string().min(1).max(64) });
export type InvoiceIdParams = z.infer<typeof invoiceIdParamsSchema>;

export const listInvoicesQuerySchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  /** Matches orderId exactly, or the invoice id by prefix. */
  q: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const refundSchema = z.object({ toAddress: z.string().min(4).max(256) });
export type RefundBody = z.infer<typeof refundSchema>;

export const createPayoutSchema = z
  .object({
    kind: z.enum(["cooperative", "exit"]),
    toAddress: z.string().trim().min(4).max(256),
    amountSats: satsStringSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "cooperative" && value.amountSats === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountSats"],
        message: "amountSats is required for cooperative payouts",
      });
    }
    if (value.kind === "exit" && value.amountSats !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountSats"],
        message: "amountSats is forbidden for exit — an exit sweeps the entire balance",
      });
    }
  });
export type CreatePayoutBody = z.infer<typeof createPayoutSchema>;

export const listPayoutsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListPayoutsQuery = z.infer<typeof listPayoutsQuerySchema>;

export const simulatePaymentSchema = z.object({
  address: z.string().min(4).max(256),
  amountSats: satsStringSchema,
});
export type SimulatePaymentBody = z.infer<typeof simulatePaymentSchema>;
