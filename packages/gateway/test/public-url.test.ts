import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolvePublicUrl } from "../src/config";
import { authHeaders, makeHarness, type Harness } from "./helpers";

const base = { OPENTILL_API_KEY: "k", OPENTILL_WEBHOOK_SECRET: "s" };

describe("resolvePublicUrl", () => {
  it("prefers OPENTILL_PUBLIC_URL and normalizes trailing slashes", () => {
    expect(resolvePublicUrl({ OPENTILL_PUBLIC_URL: "https://pay.example.com/", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" })).toBe(
      "https://pay.example.com",
    );
    expect(resolvePublicUrl({ OPENTILL_PUBLIC_URL: "https://example.com/till//" })).toBe("https://example.com/till");
  });

  it("falls back to https://$RAILWAY_PUBLIC_DOMAIN", () => {
    expect(resolvePublicUrl({ RAILWAY_PUBLIC_DOMAIN: "opentill-live-production.up.railway.app" })).toBe(
      "https://opentill-live-production.up.railway.app",
    );
  });

  it("is null when neither is set (links stay relative)", () => {
    expect(resolvePublicUrl({})).toBeNull();
    expect(resolvePublicUrl({ OPENTILL_PUBLIC_URL: "  ", RAILWAY_PUBLIC_DOMAIN: "" })).toBeNull();
  });

  it("rejects a non-http(s) or relative OPENTILL_PUBLIC_URL at boot", () => {
    expect(() => loadConfig({ ...base, OPENTILL_PUBLIC_URL: "pay.example.com" })).toThrow(/OPENTILL_PUBLIC_URL/);
    expect(() => loadConfig({ ...base, OPENTILL_PUBLIC_URL: "ftp://pay.example.com" })).toThrow(/OPENTILL_PUBLIC_URL/);
    expect(loadConfig({ ...base, RAILWAY_PUBLIC_DOMAIN: "a.up.railway.app" }).publicUrl).toBe("https://a.up.railway.app");
  });
});

describe("checkoutUrl on merchant invoice responses", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.destroy();
    h = undefined;
  });

  it("is absolute when a public URL is configured", async () => {
    h = await makeHarness({ configOverrides: { publicUrl: "https://till.example" } });
    const res = await h.app.inject({ method: "POST", url: "/api/invoices", headers: authHeaders(), payload: { amountSats: "1000" } });
    expect(res.statusCode).toBe(201);
    const { id, checkoutUrl } = res.json() as { id: string; checkoutUrl: string };
    expect(checkoutUrl).toBe(`https://till.example/pay/${id}`);

    const list = await h.app.inject({ method: "GET", url: "/api/invoices", headers: authHeaders() });
    expect((list.json() as { invoices: Array<{ checkoutUrl: string }> }).invoices[0]!.checkoutUrl).toBe(checkoutUrl);
  });

  it("is null without one", async () => {
    h = await makeHarness();
    const res = await h.app.inject({ method: "POST", url: "/api/invoices", headers: authHeaders(), payload: { amountSats: "1000" } });
    expect((res.json() as { checkoutUrl: unknown }).checkoutUrl).toBeNull();
  });
});
