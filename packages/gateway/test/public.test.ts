import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoice, PublicInvoiceDTO } from "@opentill/shared";
import type { TachiAdapter } from "@opentill/adapter";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { toPublicInvoiceDTO } from "../src/serialize";
import {
  authHeaders,
  connectSse,
  makeHarness,
  waitUntil,
  type Harness,
  type HarnessOptions,
} from "./helpers";

const PUBLIC_FIELDS = [
  "id",
  "status",
  "amountSats",
  "amountPaidSats",
  "memo",
  "address",
  "paymentUri",
  "merchantName",
  "returnUrl",
  "createdAt",
  "expiresAt",
  "latePayment",
  "devSimulate",
].sort();

const FORBIDDEN_FIELDS = [
  "orderId",
  "webhookUrl",
  "refundAddress",
  "refundTxId",
  "refundError",
  "shortfallSats",
  "updatedAt",
];

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.destroy();
  harness = null;
});

/** Boots the harness and starts a real HTTP listener (needed for SSE). */
async function listeningHarness(opts: HarnessOptions = {}): Promise<{ h: Harness; base: string }> {
  const h = await makeHarness(opts);
  harness = h;
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = h.app.server.address() as AddressInfo;
  return { h, base: `http://127.0.0.1:${port}` };
}

async function createInvoice(
  h: Harness,
  body: Record<string, unknown> = {},
): Promise<{ id: string; address: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: authHeaders(),
    payload: {
      amountSats: "50000",
      memo: "Flat white",
      orderId: "secret-order-42",
      webhookUrl: "https://merchant.example/hook",
      ...body,
    },
  });
  expect(res.statusCode).toBe(201);
  const dto = res.json() as { id: string; address: string };
  return { id: dto.id, address: dto.address };
}

describe("public invoice serializer", () => {
  it("emits exactly the public allowlist, never merchant metadata", () => {
    const invoice: Invoice = {
      id: "inv_test",
      status: "confirmed",
      amountSats: 50_000n,
      amountPaidSats: 50_000n,
      shortfallSats: null,
      address: "mock1pxyz",
      memo: "Flat white",
      orderId: "secret-order-42",
      webhookUrl: "https://merchant.example/hook",
      returnUrl: "https://store.example/thanks",
      refundAddress: "mock1prefund",
      refundTxId: "mocktx_1",
      refundError: "boom",
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      confirmedAt: 2,
    };

    const dto = toPublicInvoiceDTO(invoice, {
      latePayment: true,
      devSimulate: false,
      merchantName: "Satoshi Beans",
    });

    expect(Object.keys(dto).sort()).toEqual(PUBLIC_FIELDS);
    for (const field of FORBIDDEN_FIELDS) {
      expect(dto).not.toHaveProperty(field);
    }
    expect(dto.amountSats).toBe("50000");
    expect(dto.latePayment).toBe(true);
    expect(dto.merchantName).toBe("Satoshi Beans");
  });
});

describe("GET /pay/api/:invoiceId", () => {
  it("returns the public view without merchant fields", async () => {
    harness = await makeHarness();
    const { id } = await createInvoice(harness);

    const res = await harness.app.inject({ method: "GET", url: `/pay/api/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PublicInvoiceDTO;

    expect(Object.keys(body).sort()).toEqual(PUBLIC_FIELDS);
    for (const field of FORBIDDEN_FIELDS) {
      expect(body).not.toHaveProperty(field);
    }
    expect(body.id).toBe(id);
    expect(body.status).toBe("pending");
    expect(body.memo).toBe("Flat white");
    expect(body.devSimulate).toBe(false);
    expect(body.merchantName).toBe("OpenTill"); // default when env unset
    const raw = res.body;
    expect(raw).not.toContain("secret-order-42");
    expect(raw).not.toContain("merchant.example");
  });

  it("carries returnUrl in the public payload and validates it strictly", async () => {
    harness = await makeHarness();

    const { id } = await createInvoice(harness, { returnUrl: "https://store.example/thanks/7" });
    const res = await harness.app.inject({ method: "GET", url: `/pay/api/${id}` });
    expect((res.json() as PublicInvoiceDTO).returnUrl).toBe("https://store.example/thanks/7");

    // Absent by default.
    const bare = await createInvoice(harness);
    const bareRes = await harness.app.inject({ method: "GET", url: `/pay/api/${bare.id}` });
    expect((bareRes.json() as PublicInvoiceDTO).returnUrl).toBeNull();

    // Rejected: non-http(s) schemes and garbage. This link renders on the
    // public checkout page; javascript: must never get through.
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "not a url", "ftp://x.example"]) {
      const rejected = await harness.app.inject({
        method: "POST",
        url: "/api/invoices",
        headers: authHeaders(),
        payload: { amountSats: "1000", returnUrl: bad },
      });
      expect(rejected.statusCode).toBe(400);
      expect((rejected.json() as { error: string }).error).toBe("validation_error");
    }
  });

  it("reflects the configured merchant name (OPENTILL_MERCHANT_NAME)", async () => {
    harness = await makeHarness({ configOverrides: { merchantName: "Satoshi Beans" } });
    const { id } = await createInvoice(harness);
    const res = await harness.app.inject({ method: "GET", url: `/pay/api/${id}` });
    expect((res.json() as PublicInvoiceDTO).merchantName).toBe("Satoshi Beans");
  });

  it("404s with one uniform shape for unknown and malformed ids", async () => {
    harness = await makeHarness();

    const unknown = await harness.app.inject({ method: "GET", url: "/pay/api/inv_nope" });
    const malformed = await harness.app.inject({ method: "GET", url: `/pay/api/${"x".repeat(90)}` });

    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "not_found" });
    expect(unknown.body).toBe(malformed.body);
  });
});

describe("SSE /pay/api/:invoiceId/events", () => {
  it("streams snapshot -> paid -> confirmed and cleans up on disconnect", async () => {
    const { h, base } = await listeningHarness({
      configOverrides: { devPublicSimulate: true },
    });
    const { id } = await createInvoice(h);

    const sse = await connectSse(`${base}/pay/api/${id}/events`);

    const snapshot = await sse.waitForEvent((e) => e.event === "status", "snapshot");
    const snapshotBody = JSON.parse(snapshot.data) as PublicInvoiceDTO;
    expect(snapshotBody.status).toBe("pending");
    expect(snapshotBody.devSimulate).toBe(true);
    expect(Object.keys(snapshotBody).sort()).toEqual(PUBLIC_FIELDS);

    // Public, unauthenticated demo button endpoint.
    const simulated = await fetch(`${base}/dev/pay/${id}`, { method: "POST" });
    expect(simulated.status).toBe(202);
    expect(((await simulated.json()) as { simulatedSats: string }).simulatedSats).toBe("50000");

    const paid = await sse.waitForEvent(
      (e) => e.event === "status" && (JSON.parse(e.data) as PublicInvoiceDTO).status === "paid",
      "paid event",
    );
    expect((JSON.parse(paid.data) as PublicInvoiceDTO).amountPaidSats).toBe("50000");

    h.mock.forceCommitAll();
    await h.poller.tick();

    const confirmed = await sse.waitForEvent(
      (e) => e.event === "status" && (JSON.parse(e.data) as PublicInvoiceDTO).status === "confirmed",
      "confirmed event",
    );
    for (const field of FORBIDDEN_FIELDS) {
      expect(JSON.parse(confirmed.data)).not.toHaveProperty(field);
    }

    expect(h.events.listenerCount(id)).toBe(1);
    sse.close();
    await waitUntil(() => h.events.listenerCount(id) === 0, "listener cleanup");
  });

  it("emits heartbeats", async () => {
    const { h, base } = await listeningHarness({
      configOverrides: { sseHeartbeatMs: 40 },
    });
    const { id } = await createInvoice(h);

    const sse = await connectSse(`${base}/pay/api/${id}/events`);
    await sse.waitForEvent((e) => e.event === "heartbeat", "heartbeat");
    sse.close();
  });

  it("404s for unknown invoices with the uniform shape", async () => {
    const { base } = await listeningHarness();
    const res = await fetch(`${base}/pay/api/inv_nope/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("leaks no listeners after 50 connect/disconnect cycles", async () => {
    const { h, base } = await listeningHarness();
    const { id } = await createInvoice(h);

    for (let i = 0; i < 50; i += 1) {
      const sse = await connectSse(`${base}/pay/api/${id}/events`);
      await sse.waitForEvent((e) => e.event === "status", `snapshot #${i}`);
      sse.close();
    }

    await waitUntil(() => h.events.listenerCount(id) === 0, "all listeners removed");
    expect(h.events.listenerCount(id)).toBe(0);
  });
});

describe("POST /dev/pay/:invoiceId", () => {
  it("does not exist when the flag is off", async () => {
    const { h, base } = await listeningHarness();
    const { id } = await createInvoice(h);

    const res = await fetch(`${base}/dev/pay/${id}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("pays exactly the remaining amount and refuses non-pending invoices", async () => {
    harness = await makeHarness({ configOverrides: { devPublicSimulate: true } });
    const { id } = await createInvoice(harness);

    const first = await harness.app.inject({ method: "POST", url: `/dev/pay/${id}` });
    expect(first.statusCode).toBe(202);
    expect((first.json() as { simulatedSats: string }).simulatedSats).toBe("50000");

    const view = await harness.app.inject({ method: "GET", url: `/pay/api/${id}` });
    const body = view.json() as PublicInvoiceDTO;
    expect(body.status).toBe("paid");
    expect(body.amountPaidSats).toBe("50000");

    const again = await harness.app.inject({ method: "POST", url: `/dev/pay/${id}` });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: string }).error).toBe("invalid_state");
  });

  it("404s for unknown invoices", async () => {
    harness = await makeHarness({ configOverrides: { devPublicSimulate: true } });
    const res = await harness.app.inject({ method: "POST", url: "/dev/pay/inv_nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("dev-simulate boot safety", () => {
  const baseEnv = {
    OPENTILL_API_KEY: "k",
    OPENTILL_WEBHOOK_SECRET: "s",
  };

  it("loadConfig refuses OPENTILL_DEV_PUBLIC_SIMULATE=true with a non-mock adapter", () => {
    expect(() =>
      loadConfig({ ...baseEnv, OPENTILL_DEV_PUBLIC_SIMULATE: "true", ADAPTER_MODE: "tachi" }),
    ).toThrow(/mock/i);
  });

  it("loadConfig enables the flag only outside production", () => {
    const dev = loadConfig({ ...baseEnv, OPENTILL_DEV_PUBLIC_SIMULATE: "true" });
    expect(dev.devPublicSimulate).toBe(true);

    const prod = loadConfig({
      ...baseEnv,
      OPENTILL_DEV_PUBLIC_SIMULATE: "true",
      NODE_ENV: "production",
    });
    expect(prod.devPublicSimulate).toBe(false);

    const off = loadConfig(baseEnv);
    expect(off.devPublicSimulate).toBe(false);
  });

  it("createApp refuses the flag when the effective adapter is not the mock", async () => {
    const fakeAdapter: TachiAdapter = {
      init: async () => {},
      createReceiveAddress: async () => ({ address: "real1x" }),
      pollIncoming: async () => ({ payments: [], nextCursor: "0" }),
      watchAddress: async () => {},
      unwatchAddress: async () => {},
      send: async () => ({ txId: "tx" }),
      getBalance: async () => ({ offchainSats: 0n, onchainSats: 0n }),
      initiatePayout: async () => {
        throw new Error("not implemented in fake");
      },
      pollPayouts: async () => [],
    };
    const config = loadConfig({ ...baseEnv, OPENTILL_DEV_PUBLIC_SIMULATE: "true" });
    await expect(
      createApp({ ...config, dbPath: ":memory:" }, { adapter: fakeAdapter }),
    ).rejects.toThrow(/mock/i);
  });
});
