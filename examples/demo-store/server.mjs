// Satoshi Beans — a deliberately tiny demo store proving the OpenTill
// integration round trip: buy -> hosted checkout -> webhook -> thanks page.
// Plain node:http, no dependencies, no build step. It is a prop, not a product.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PRODUCTS = [
  { id: "ristretto", name: "Ristretto Roast 250g", priceSats: 21_000 },
  { id: "hodl", name: "HODL House Blend 500g", priceSats: 35_000 },
  { id: "genesis", name: "Genesis Block Espresso 1kg", priceSats: 60_000 },
];

export function createDemoStore(config) {
  const {
    gatewayUrl, // server-side API calls (docker-internal DNS in compose)
    publicGatewayUrl = config.gatewayUrl, // where the BROWSER is sent to pay
    apiKey, // stays server-side, never rendered
    webhookSecret,
    baseUrl, // reachable FROM THE GATEWAY (docker-internal DNS in compose)
    publicBaseUrl = config.baseUrl, // reachable from the BROWSER (return links)
    log = (...args) => console.log("[demo-store]", ...args),
  } = config;

  /** orderId -> { product, invoiceId, paid } — in-memory, resets on restart. */
  const orders = new Map();
  let orderSeq = 0;

  const html = (res, status, body) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Satoshi Beans</title></head>
<body style="font-family: system-ui, sans-serif; background:#f5f2ec; color:#222; max-width:640px; margin:40px auto; padding:0 16px;">
${body}
<p style="margin-top:40px;color:#999;font-size:12px">Satoshi Beans — OpenTill demo store. Not a real shop.</p>
</body></html>`);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      log("error:", err.message);
      html(res, 500, `<h1>Something broke</h1><p>${escapeHtml(err.message)}</p>`);
    });
  });

  async function route(req, res) {
    const url = new URL(req.url ?? "/", "http://x");

    if (req.method === "GET" && url.pathname === "/") {
      const rows = PRODUCTS.map(
        (p) => `<div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0;display:flex;justify-content:space-between;align-items:center">
  <div><strong>${p.name}</strong><br><span style="color:#666">${p.priceSats.toLocaleString("en").replace(/,/g, " ")} sats</span></div>
  <form method="post" action="/buy"><input type="hidden" name="product" value="${p.id}">
  <button style="background:#f7931a;border:0;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer">Buy</button></form>
</div>`,
      ).join("");
      return html(res, 200, `<h1>☕ Satoshi Beans</h1><p>Pay with Bitcoin via OpenTill.</p>${rows}`);
    }

    if (req.method === "POST" && url.pathname === "/buy") {
      const body = (await readBody(req)).toString("utf8");
      const productId = new URLSearchParams(body).get("product");
      const product = PRODUCTS.find((p) => p.id === productId);
      if (!product) return html(res, 400, "<h1>Unknown product</h1>");

      orderSeq += 1;
      const orderId = `beans-${orderSeq}`;

      // The API key is used HERE, server-side only. The browser never sees it.
      const invoiceRes = await fetch(`${gatewayUrl}/api/invoices`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          amountSats: String(product.priceSats),
          memo: `Satoshi Beans — ${product.name}`,
          orderId,
          webhookUrl: `${baseUrl}/webhook`,
          returnUrl: `${publicBaseUrl}/thanks/${orderId}`,
        }),
      });
      if (!invoiceRes.ok) {
        const text = await invoiceRes.text();
        return html(
          res,
          502,
          `<h1>Could not create invoice</h1><pre>${escapeHtml(text.slice(0, 500))}</pre>`,
        );
      }
      const invoice = await invoiceRes.json();
      orders.set(orderId, { product, invoiceId: invoice.id, paid: false });
      log(`order ${orderId}: invoice ${invoice.id} for ${product.priceSats} sats`);

      res.writeHead(302, { location: `${publicGatewayUrl}/pay/${invoice.id}` });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const raw = await readBody(req);
      const signature = String(req.headers["x-opentill-signature"] ?? "");
      const expected = createHmac("sha256", webhookSecret).update(raw).digest("hex");
      const sigBuf = Buffer.from(signature, "utf8");
      const expBuf = Buffer.from(expected, "utf8");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        log("⚠️  webhook with BAD signature rejected");
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"bad_signature"}');
      }

      const payload = JSON.parse(raw.toString("utf8"));
      const order = orders.get(payload.orderId);
      if (order && order.invoiceId === payload.invoiceId && payload.status === "confirmed") {
        order.paid = true;
        log(`💰 order ${payload.orderId} PAID — ${payload.amountPaidSats} sats confirmed`);
      } else {
        log(`webhook: ${payload.orderId ?? "?"} ${payload.previousStatus} -> ${payload.status}`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }

    const thanks = url.pathname.match(/^\/thanks\/([^/]+)$/);
    if (req.method === "GET" && thanks) {
      const order = orders.get(thanks[1]);
      if (!order) return html(res, 404, "<h1>Order not found</h1>");
      return html(
        res,
        200,
        order.paid
          ? `<h1>✅ Thanks — payment confirmed!</h1><p>${order.product.name} is on its way. (Order ${thanks[1]}, invoice <code>${order.invoiceId}</code>.)</p><p><a href="/">Back to the shop</a></p>`
          : `<h1>⏳ Almost there…</h1><p>We haven't seen the payment confirmation for order ${thanks[1]} yet. Refresh in a moment.</p>`,
      );
    }

    return html(res, 404, "<h1>Not found</h1>");
  }

  return {
    server,
    orders,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Run directly: configuration from env.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4000);
  const baseUrl = process.env.DEMO_BASE_URL ?? `http://localhost:${port}`;
  const publicBaseUrl = process.env.DEMO_PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const store = createDemoStore({
    gatewayUrl: process.env.OPENTILL_URL ?? "http://localhost:8080",
    publicGatewayUrl: process.env.OPENTILL_PUBLIC_URL ?? process.env.OPENTILL_URL ?? "http://localhost:8080",
    apiKey: process.env.OPENTILL_API_KEY ?? "",
    webhookSecret: process.env.OPENTILL_WEBHOOK_SECRET ?? "",
    baseUrl,
    publicBaseUrl,
  });
  void store.listen(port, process.env.HOST ?? "0.0.0.0").then(() => {
    console.log(`[demo-store] Satoshi Beans ready on ${baseUrl}`);
  });
}
