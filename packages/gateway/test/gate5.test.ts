import { createServer } from "node:net";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoStore, type DemoStore } from "../../../examples/demo-store/server.mjs";
import { authHeaders, makeHarness, waitUntil, type Harness } from "./helpers";

let h: Harness | null = null;
let store: DemoStore | null = null;

afterEach(async () => {
  if (store) await store.close();
  store = null;
  if (h) await h.destroy();
  h = null;
});

/** Grab a free port by binding an ephemeral listener and releasing it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("demo store round trip (Part D)", () => {
  it("buy -> invoice with correct URLs -> pay -> HMAC webhook flips the order to paid", async () => {
    h = await makeHarness({ configOverrides: { devPublicSimulate: true } });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const gatewayUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;

    const storePort = await freePort();
    const baseUrl = `http://127.0.0.1:${storePort}`;
    store = createDemoStore({
      gatewayUrl,
      apiKey: "test_api_key",
      webhookSecret: "test_webhook_secret",
      baseUrl,
      log: () => {},
    });
    await store.listen(storePort);

    // Storefront renders the three products.
    const front = await fetch(baseUrl);
    expect(front.status).toBe(200);
    expect(await front.text()).toContain("Satoshi Beans");

    // Buy: the store creates the invoice server-side and redirects the
    // browser to the hosted checkout.
    const buy = await fetch(`${baseUrl}/buy`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "product=ristretto",
      redirect: "manual",
    });
    expect(buy.status).toBe(302);
    const location = buy.headers.get("location")!;
    expect(location).toMatch(new RegExp(`^${gatewayUrl}/pay/inv_[0-9a-f]{32}$`));
    const invoiceId = location.split("/pay/")[1]!;

    // The invoice carries the store's webhook + return URLs and the order id.
    const invoiceRes = await h.app.inject({
      method: "GET",
      url: `/api/invoices/${invoiceId}`,
      headers: authHeaders(),
    });
    const invoice = invoiceRes.json<Record<string, unknown>>();
    expect(invoice.orderId).toBe("beans-1");
    expect(invoice.webhookUrl).toBe(`${baseUrl}/webhook`);
    expect(invoice.returnUrl).toBe(`${baseUrl}/thanks/beans-1`);
    expect(invoice.amountSats).toBe("21000");

    // Thanks page before payment: pending.
    expect(await (await fetch(`${baseUrl}/thanks/beans-1`)).text()).toContain("Almost there");
    expect(store.orders.get("beans-1")?.paid).toBe(false);

    // A forged webhook must be rejected and change nothing.
    const forged = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opentill-signature": "deadbeef" },
      body: JSON.stringify({ orderId: "beans-1", invoiceId, status: "confirmed" }),
    });
    expect(forged.status).toBe(401);
    expect(store.orders.get("beans-1")?.paid).toBe(false);

    // Customer pays (public dev-simulate, as the checkout demo button does),
    // payment commits, the gateway's signed webhooks flow to the store.
    const sim = await fetch(`${gatewayUrl}/dev/pay/${invoiceId}`, { method: "POST" });
    expect(sim.status).toBe(202);
    h.mock.forceCommitAll();
    await h.poller.tick();
    await h.webhooks.sweep();

    await waitUntil(() => store!.orders.get("beans-1")?.paid === true, "order marked paid");

    // Thanks page proves the round trip.
    const thanks = await (await fetch(`${baseUrl}/thanks/beans-1`)).text();
    expect(thanks).toContain("payment confirmed");
    expect(thanks).toContain(invoiceId);
  });
});
