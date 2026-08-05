import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, makeHarness, type Harness } from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.destroy();
});

async function create(payload: Record<string, unknown>) {
  return h.app.inject({ method: "POST", url: "/api/invoices", headers: authHeaders(), payload });
}

describe("healthz", () => {
  it("needs no auth and reports adapter mode and db health", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, adapterMode: "mock", dbOk: true });
  });
});

describe("auth", () => {
  it.each([
    ["missing header", {}],
    ["wrong scheme", { authorization: "Basic test_api_key" }],
    ["wrong key", { authorization: "Bearer nope" }],
    ["empty bearer", { authorization: "Bearer " }],
  ])("rejects %s with 401", async (_label, headers) => {
    const res = await h.app.inject({ method: "GET", url: "/api/invoices", headers });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe("unauthorized");
  });

  it("accepts the configured key", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/invoices", headers: authHeaders() });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/invoices validation", () => {
  it.each([
    ["missing amount", {}],
    ["non-numeric amount", { amountSats: "12.5" }],
    ["negative amount", { amountSats: "-100" }],
    ["zero amount", { amountSats: "0" }],
    ["amount as a number", { amountSats: 100 }],
    ["bad webhook url", { amountSats: "100", webhookUrl: "not-a-url" }],
    ["expiry too short", { amountSats: "100", expiresInSeconds: 5 }],
    ["expiry too long", { amountSats: "100", expiresInSeconds: 999_999 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const res = await create(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("validation_error");
  });

  it("accepts an amount larger than Number.MAX_SAFE_INTEGER without losing precision", async () => {
    const huge = "9007199254740993";
    const res = await create({ amountSats: huge });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ amountSats: string }>().amountSats).toBe(huge);
    expect(h.repo.getInvoice(res.json<{ id: string }>().id)?.amountSats).toBe(BigInt(huge));
  });

  it("defaults expiry to 15 minutes and watches the derived address", async () => {
    const before = Date.now();
    const res = await create({ amountSats: "1000" });
    const invoice = res.json<{ expiresAt: number; address: string }>();
    expect(invoice.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(invoice.expiresAt).toBeLessThan(before + 15 * 60_000 + 5_000);

    // Watched: a simulated payment to it reaches the poller.
    h.mock.simulateIncomingPayment(invoice.address, 1000n);
    const result = await h.poller.tick();
    expect(result.applied).toBe(1);
  });

  it("derives a distinct address per invoice", async () => {
    const addresses = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await create({ amountSats: "1000" });
      addresses.add(res.json<{ address: string }>().address);
    }
    expect(addresses.size).toBe(5);
  });
});

describe("GET /api/invoices", () => {
  it("lists newest first, filters by status and paginates", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await create({ amountSats: `${1000 + i}`, orderId: `order-${i}` });
      ids.push(res.json<{ id: string }>().id);
    }

    // Pay the last one so it has a non-pending status.
    const paidInvoice = h.repo.getInvoice(ids[4]!)!;
    h.mock.simulateIncomingPayment(paidInvoice.address, paidInvoice.amountSats);
    await h.poller.tick();

    const all = await h.app.inject({
      method: "GET",
      url: "/api/invoices",
      headers: authHeaders(),
    });
    const list = all.json<{ invoices: Array<{ id: string }>; total: number }>();
    expect(list.total).toBe(5);
    expect(list.invoices).toHaveLength(5);
    // Newest first — created_at ties are broken by id, so just check membership
    // and that the most recent is at the head.
    expect(list.invoices[0]?.id).toBe(ids[4]);

    const pending = await h.app.inject({
      method: "GET",
      url: "/api/invoices?status=pending",
      headers: authHeaders(),
    });
    const pendingBody = pending.json<{ invoices: unknown[]; total: number }>();
    expect(pendingBody.total).toBe(4);
    expect(pendingBody.invoices).toHaveLength(4);

    const page = await h.app.inject({
      method: "GET",
      url: "/api/invoices?limit=2&offset=2",
      headers: authHeaders(),
    });
    const pageBody = page.json<{ invoices: unknown[]; limit: number; offset: number }>();
    expect(pageBody.invoices).toHaveLength(2);
    expect(pageBody).toMatchObject({ limit: 2, offset: 2, total: 5 });
  });

  it("rejects a bad status filter", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/invoices?status=nonsense",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/invoices/:id", () => {
  it("404s an unknown id", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/invoices/inv_nope",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("includes payments", async () => {
    const created = await create({ amountSats: "3000" });
    const invoice = created.json<{ id: string; address: string }>();
    h.mock.simulateIncomingPayment(invoice.address, 3000n);
    await h.poller.tick();

    const res = await h.app.inject({
      method: "GET",
      url: `/api/invoices/${invoice.id}`,
      headers: authHeaders(),
    });
    const body = res.json<{ payments: Array<Record<string, unknown>> }>();
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({
      amountSats: "3000",
      status: "seen",
      latePayment: false,
      address: invoice.address,
    });
  });
});

describe("GET /api/balance", () => {
  it("proxies the adapter balance as strings", async () => {
    const created = await create({ amountSats: "7777" });
    h.mock.simulateIncomingPayment(created.json<{ address: string }>().address, 7777n);

    const res = await h.app.inject({ method: "GET", url: "/api/balance", headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ offchainSats: "7777", onchainSats: "0" });
  });
});

describe("dev routes", () => {
  it("simulates a payment when enabled", async () => {
    const created = await create({ amountSats: "100" });
    const res = await h.app.inject({
      method: "POST",
      url: "/dev/simulate-payment",
      headers: authHeaders(),
      payload: { address: created.json<{ address: string }>().address, amountSats: "100" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ status: string }>().status).toBe("seen");
  });

  it("still requires the API key", async () => {
    const created = await create({ amountSats: "100" });
    const res = await h.app.inject({
      method: "POST",
      url: "/dev/simulate-payment",
      headers: { "content-type": "application/json" },
      payload: { address: created.json<{ address: string }>().address, amountSats: "100" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is not mounted when dev routes are disabled", async () => {
    const prod = await makeHarness({ configOverrides: { devRoutesEnabled: false } });
    try {
      const res = await prod.app.inject({
        method: "POST",
        url: "/dev/simulate-payment",
        headers: authHeaders(),
        payload: { address: "mock1pwhatever", amountSats: "100" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await prod.destroy();
    }
  });
});
