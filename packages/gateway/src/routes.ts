import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createInvoiceSchema,
  createPayoutSchema,
  invoiceIdParamsSchema,
  listInvoicesQuerySchema,
  listPayoutsQuerySchema,
  refundSchema,
  simulatePaymentSchema,
} from "@opentill/shared";
import { MockTachiAdapter } from "@opentill/adapter";
import type { GatewayConfig } from "./config";
import { isDbHealthy } from "./db";
import { InvalidTransitionError } from "./domain/state-machine";
import {
  createInvoice,
  InvoiceNotFoundError,
  refundInvoice,
  type ServiceContext,
} from "./domain/invoices";
import { applyAdapterPayout } from "./domain/payouts";
import {
  toInvoiceDTO,
  toPaymentDTO,
  toPayoutDTO,
  toStatsDTO,
  toWebhookDeliveryDTO,
} from "./serialize";

export interface RouteDeps {
  config: GatewayConfig;
  ctx: ServiceContext;
  /** Nudges the webhook dispatcher after a state change instead of waiting for the sweep. */
  flushWebhooks: () => void;
}

function parseOr400<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
): z.infer<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({
    error: "validation_error",
    message: "request failed validation",
    details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, ctx } = deps;

  const requireApiKey = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !constantTimeEquals(token, config.apiKey)) {
      await reply.code(401).send({ error: "unauthorized", message: "missing or invalid API key" });
    }
  };

  app.get("/healthz", async () => ({
    ok: true,
    adapterMode: config.adapterMode,
    dbOk: isDbHealthy(ctx.repo.db),
  }));

  // ---- merchant API (bearer auth) -------------------------------------------
  await app.register(async (api) => {
    api.addHook("onRequest", requireApiKey);

    api.post("/api/invoices", async (request, reply) => {
      const body = parseOr400(createInvoiceSchema, request.body, reply);
      if (!body) return reply;
      const invoice = await createInvoice(ctx, body);
      deps.flushWebhooks();
      return reply.code(201).send(toInvoiceDTO(invoice));
    });

    api.get("/api/invoices", async (request, reply) => {
      const query = parseOr400(listInvoicesQuerySchema, request.query, reply);
      if (!query) return reply;
      const invoices = ctx.repo.listInvoices(query);
      return reply.send({
        invoices: invoices.map(toInvoiceDTO),
        total: ctx.repo.countInvoices(query.status, query.q),
        limit: query.limit,
        offset: query.offset,
      });
    });

    api.get("/api/stats", async (_request, reply) => {
      return reply.send(toStatsDTO(ctx.repo.getStats(Date.now() - 24 * 60 * 60 * 1000)));
    });

    api.get("/api/invoices/:id/webhook-deliveries", async (request, reply) => {
      const params = parseOr400(invoiceIdParamsSchema, request.params, reply);
      if (!params) return reply;
      if (!ctx.repo.getInvoice(params.id)) {
        return reply.code(404).send({ error: "not_found", message: `invoice ${params.id} not found` });
      }
      return reply.send({
        deliveries: ctx.repo.listWebhooksForInvoice(params.id).map(toWebhookDeliveryDTO),
      });
    });

    api.post("/api/webhook-deliveries/:id/retry", async (request, reply) => {
      const params = parseOr400(invoiceIdParamsSchema, request.params, reply);
      if (!params) return reply;
      const delivery = ctx.repo.getWebhook(params.id);
      if (!delivery) {
        return reply.code(404).send({ error: "not_found", message: `delivery ${params.id} not found` });
      }
      if (delivery.status !== "failed") {
        return reply.code(409).send({
          error: "invalid_state",
          message: `delivery is ${delivery.status}; only failed deliveries can be retried`,
        });
      }
      ctx.repo.requeueWebhook(params.id);
      deps.flushWebhooks();
      const requeued = ctx.repo.getWebhook(params.id);
      return reply.code(202).send({ delivery: toWebhookDeliveryDTO(requeued ?? delivery) });
    });

    api.get("/api/invoices/:id", async (request, reply) => {
      const params = parseOr400(invoiceIdParamsSchema, request.params, reply);
      if (!params) return reply;
      const invoice = ctx.repo.getInvoice(params.id);
      if (!invoice) {
        return reply.code(404).send({ error: "not_found", message: `invoice ${params.id} not found` });
      }
      return reply.send({
        ...toInvoiceDTO(invoice),
        payments: ctx.repo.listPaymentsForInvoice(invoice.id).map(toPaymentDTO),
      });
    });

    api.post("/api/invoices/:id/refund", async (request, reply) => {
      const params = parseOr400(invoiceIdParamsSchema, request.params, reply);
      if (!params) return reply;
      const body = parseOr400(refundSchema, request.body, reply);
      if (!body) return reply;

      try {
        const result = await refundInvoice(ctx, params.id, body.toAddress);
        deps.flushWebhooks();
        if (result.exitPending) {
          // The invoice has already reverted refund_pending -> confirmed with
          // the error recorded, exactly like any other failed send.
          return reply.code(409).send({
            error: "exit_pending",
            message: result.error,
            invoice: toInvoiceDTO(result.invoice),
          });
        }
        if (result.error !== null) {
          return reply.code(502).send({
            error: "refund_failed",
            message: result.error,
            invoice: toInvoiceDTO(result.invoice),
          });
        }
        return reply.send({ txId: result.txId, invoice: toInvoiceDTO(result.invoice) });
      } catch (err) {
        if (err instanceof InvoiceNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: err.message });
        }
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({
            error: "invalid_state",
            message: err.message,
            from: err.from,
            to: err.to,
          });
        }
        throw err;
      }
    });

    // ---- payouts (money out) ----------------------------------------------

    api.post("/api/payouts", async (request, reply) => {
      const body = parseOr400(createPayoutSchema, request.body, reply);
      if (!body) return reply;

      // One exit at a time, and nothing else while it runs: the vault is
      // being swept. Checked here for a clean 409 before touching the adapter.
      const pendingExit = ctx.repo.findPendingExit();
      if (pendingExit) {
        return reply.code(409).send({
          error: "exit_pending",
          message:
            body.kind === "exit"
              ? "a unilateral exit is already in progress — one exit at a time"
              : "a unilateral exit is sweeping the vault — off-chain funds are locked until it settles",
          payout: toPayoutDTO(pendingExit),
        });
      }

      const snapshot = await ctx.adapter.initiatePayout({
        kind: body.kind,
        toAddress: body.toAddress,
        ...(body.amountSats !== undefined ? { amountSats: BigInt(body.amountSats) } : {}),
      });

      const payout = ctx.repo.db.transaction(() => applyAdapterPayout(ctx, snapshot))();
      deps.flushWebhooks();
      if (!payout) {
        throw new Error(`payout ${snapshot.payoutId} was not recorded`);
      }
      if (payout.status === "failed") {
        return reply.code(400).send({
          error: "payout_failed",
          message: payout.error ?? "the adapter rejected the payout",
          payout: toPayoutDTO(payout),
        });
      }
      return reply.code(201).send(toPayoutDTO(payout));
    });

    api.get("/api/payouts", async (request, reply) => {
      const query = parseOr400(listPayoutsQuerySchema, request.query, reply);
      if (!query) return reply;
      return reply.send({
        payouts: ctx.repo.listPayouts(query).map(toPayoutDTO),
        total: ctx.repo.countPayouts(),
        limit: query.limit,
        offset: query.offset,
      });
    });

    api.get("/api/payouts/:id", async (request, reply) => {
      const params = parseOr400(invoiceIdParamsSchema, request.params, reply);
      if (!params) return reply;
      const payout = ctx.repo.getPayout(params.id);
      if (!payout) {
        return reply.code(404).send({ error: "not_found", message: `payout ${params.id} not found` });
      }
      return reply.send(toPayoutDTO(payout));
    });

    api.get("/api/balance", async (_request, reply) => {
      const balance = await ctx.adapter.getBalance();
      return reply.send({
        offchainSats: balance.offchainSats.toString(),
        onchainSats: balance.onchainSats.toString(),
      });
    });
  });

  // ---- dev-only helpers ------------------------------------------------------
  // Gated on non-production + mock adapter, and still behind the API key: a dev
  // instance bound to 0.0.0.0 must not let a passer-by mint payments.
  if (!config.devRoutesEnabled) return;

  await app.register(async (dev) => {
    dev.addHook("onRequest", requireApiKey);

    dev.post("/dev/simulate-payment", async (request, reply) => {
      const body = parseOr400(simulatePaymentSchema, request.body, reply);
      if (!body) return reply;
      if (!(ctx.adapter instanceof MockTachiAdapter)) {
        return reply
          .code(409)
          .send({ error: "unavailable", message: "simulation requires the mock adapter" });
      }
      const payment = ctx.adapter.simulateIncomingPayment(body.address, BigInt(body.amountSats));
      return reply.code(202).send({
        paymentId: payment.paymentId,
        toAddress: payment.toAddress,
        amountSats: payment.amountSats.toString(),
        status: payment.status,
        observedAt: payment.observedAt,
      });
    });
  });
}
