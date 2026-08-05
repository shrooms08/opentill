import type { FastifyInstance, FastifyReply } from "fastify";
import type { Invoice, PublicInvoiceDTO } from "@opentill/shared";
import { MockTachiAdapter } from "@opentill/adapter";
import type { GatewayConfig } from "./config";
import type { ServiceContext } from "./domain/invoices";
import { toPublicInvoiceDTO } from "./serialize";

export interface PublicRouteDeps {
  config: GatewayConfig;
  ctx: ServiceContext;
  /** Runs one poller tick so a simulated payment is applied before we respond. */
  pokePoller: () => Promise<void>;
  /** True when apps/web/dist exists and @fastify/static was registered. */
  webDistAvailable: boolean;
}

interface InvoiceIdParams {
  invoiceId: string;
}

/**
 * Everything under /pay/* and /dev/pay/* is unauthenticated: the invoice id
 * (128-bit random) is the bearer capability. Unknown ids get one uniform 404 —
 * same shape, same code path — so the routes leak no existence oracle.
 */
export async function registerPublicRoutes(
  app: FastifyInstance,
  deps: PublicRouteDeps,
): Promise<void> {
  const { config, ctx } = deps;

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "not_found" });

  const lookup = (params: unknown): Invoice | null => {
    const { invoiceId } = params as InvoiceIdParams;
    if (typeof invoiceId !== "string" || invoiceId.length === 0 || invoiceId.length > 64) {
      return null;
    }
    return ctx.repo.getInvoice(invoiceId);
  };

  const serialize = (invoice: Invoice): PublicInvoiceDTO =>
    toPublicInvoiceDTO(invoice, {
      latePayment: ctx.repo.hasLatePayment(invoice.id),
      devSimulate: config.devPublicSimulate,
      merchantName: config.merchantName,
    });

  // ---- public invoice view ---------------------------------------------------
  app.get("/pay/api/:invoiceId", async (request, reply) => {
    const invoice = lookup(request.params);
    if (!invoice) return notFound(reply);
    return reply.send(serialize(invoice));
  });

  // ---- SSE stream ------------------------------------------------------------
  app.get("/pay/api/:invoiceId/events", (request, reply) => {
    const invoice = lookup(request.params);
    if (!invoice) {
      void notFound(reply);
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tells nginx-style reverse proxies not to buffer the stream.
      "x-accel-buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("status", serialize(invoice));

    const unsubscribe = ctx.events.subscribe(invoice.id, (event) => {
      send("status", serialize(event.invoice));
    });

    const heartbeat = setInterval(() => {
      send("heartbeat", { at: Date.now() });
    }, config.sseHeartbeatMs);
    heartbeat.unref?.();

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  // ---- checkout page ---------------------------------------------------------
  // Served unconditionally for any id shape: the page itself asks /pay/api and
  // renders the 404 view, so this route reveals nothing either.
  app.get("/pay/:invoiceId", async (_request, reply) => {
    if (!deps.webDistAvailable) {
      return reply
        .code(503)
        .type("text/plain")
        .send(
          "checkout UI is not built. Run `npm run build`, or use the Vite dev server (npm run dev -w @opentill/web).",
        );
    }
    return reply.sendFile("checkout.html");
  });

  // ---- dashboard shell -------------------------------------------------------
  // The HTML is a static shell; every piece of data behind it requires the
  // merchant API key, so serving the page itself unauthenticated is safe.
  app.get("/dashboard", async (_request, reply) => {
    if (!deps.webDistAvailable) {
      return reply
        .code(503)
        .type("text/plain")
        .send(
          "dashboard UI is not built. Run `npm run build`, or use the Vite dev server (npm run dev -w @opentill/web).",
        );
    }
    return reply.sendFile("dashboard.html");
  });

  // ---- public dev simulate ---------------------------------------------------
  // Demo-only: unauthenticated by design, so it is triple-gated — env flag on,
  // mock adapter, non-production. loadConfig has already refused flag+non-mock.
  if (!config.devPublicSimulate) return;

  app.post("/dev/pay/:invoiceId", async (request, reply) => {
    if (!(ctx.adapter instanceof MockTachiAdapter)) {
      return reply
        .code(409)
        .send({ error: "unavailable", message: "simulation requires the mock adapter" });
    }
    const invoice = lookup(request.params);
    if (!invoice) return notFound(reply);
    if (invoice.status !== "pending") {
      return reply
        .code(409)
        .send({ error: "invalid_state", message: `invoice is ${invoice.status}, not pending` });
    }

    const remaining = invoice.amountSats - invoice.amountPaidSats;
    ctx.adapter.simulateIncomingPayment(invoice.address, remaining);
    await deps.pokePoller();

    return reply.code(202).send({ ok: true, simulatedSats: remaining.toString() });
  });
}
