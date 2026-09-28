// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CheckoutState, deriveView } from "../src/shared/CheckoutState";
import type { PublicInvoice } from "../src/shared/types";

// No canvas here, so the real encoder never resolves and the <img> never
// mounts. A stub data URL lets the QR sizing test see the actual element.
vi.mock("qrcode", () => ({
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,iVBORw0KGgo=") },
}));

const NOW = 1_770_000_000_000;

const base: PublicInvoice = {
  id: "inv_fixture123",
  status: "pending",
  amountSats: "50000",
  amountPaidSats: "0",
  memo: "Flat white",
  address: "mock1pqqqqqqqqqqqqqqqqqqqqqqflatw1",
  paymentUri: "bitcoin:mock1pqqqqqqqqqqqqqqqqqqqqqqflatw1?amount=0.0005",
  merchantName: "Bitcoin Coffee Co.",
  createdAt: NOW,
  expiresAt: NOW + 15 * 60 * 1000,
  latePayment: false,
  devSimulate: false,
  returnUrl: null,
};

afterEach(cleanup);

describe("CheckoutState renders every state from fixture payloads", () => {
  it("pending: merchant name, amount, memo, address, countdown", () => {
    render(<CheckoutState invoice={base} notFound={false} />);
    expect(screen.getByText("Bitcoin Coffee Co.")).toBeDefined(); // merchantName in header
    expect(screen.getByText("50 000")).toBeDefined();
    expect(screen.getByText("0.00050000 BTC")).toBeDefined();
    expect(screen.getByText("Flat white")).toBeDefined();
    expect(screen.getByText(base.address)).toBeDefined();
    expect(screen.getByText("COPY")).toBeDefined();
    expect(screen.getByText("Expires in")).toBeDefined();
    // simulate button hidden unless the payload flags devSimulate
    expect(screen.queryByText(/Simulate payment/)).toBeNull();
  });

  it("pending with devSimulate: shows the dev button", () => {
    render(
      <CheckoutState
        invoice={{ ...base, devSimulate: true }}
        notFound={false}
        onSimulate={() => {}}
      />,
    );
    expect(screen.getByText("Simulate payment")).toBeDefined();
    expect(screen.getByText("DEV")).toBeDefined();
  });

  it("partially paid: progress line", () => {
    render(
      <CheckoutState invoice={{ ...base, amountPaidSats: "20000" }} notFound={false} />,
    );
    expect(screen.getByText(/20 000 of 50 000 received/)).toBeDefined();
    expect(screen.getByText(/Send the remaining/)).toBeDefined();
  });

  it("paid: finalizing spinner", () => {
    render(
      <CheckoutState
        invoice={{ ...base, status: "paid", amountPaidSats: "50000" }}
        notFound={false}
      />,
    );
    expect(screen.getByText("RECEIVED")).toBeDefined();
    expect(screen.getByText("Finalizing")).toBeDefined();
    // amount stays frozen on screen during the finalizing well
    expect(screen.getByText("50 000")).toBeDefined();
  });

  it("confirmed: Paid ✓ with receipt line", () => {
    render(
      <CheckoutState
        invoice={{ ...base, status: "confirmed", amountPaidSats: "50000" }}
        notFound={false}
      />,
    );
    expect(screen.getByText("Paid")).toBeDefined();
    expect(screen.queryByText("Paid ✓")).toBeNull(); // v2: no marks
    expect(screen.getByText("inv_fixture123")).toBeDefined();
  });

  it("underpaid AFTER expiry: amber warning naming both amounts", () => {
    // expiresAt in the past so the boundary (Gate 7) resolves to the amber card.
    render(
      <CheckoutState
        invoice={{ ...base, status: "underpaid", amountPaidSats: "30000", expiresAt: NOW }}
        notFound={false}
      />,
    );
    expect(screen.getByText("30 000")).toBeDefined(); // amber hero = received amount
    expect(screen.getByText(/50 000 sats/)).toBeDefined();
    expect(screen.getByText(/contact them to settle or refund/)).toBeDefined();
  });

  it("expired: muted, with late-payment note when flagged", () => {
    const { unmount } = render(
      <CheckoutState invoice={{ ...base, status: "expired" }} notFound={false} />,
    );
    expect(screen.getByText("Expired")).toBeDefined();
    expect(screen.getByText("50 000 sats")).toBeDefined(); // struck amount
    expect(screen.queryByText(/arrived after/)).toBeNull();
    unmount();

    render(
      <CheckoutState
        invoice={{ ...base, status: "expired", latePayment: true }}
        notFound={false}
      />,
    );
    expect(screen.getByText(/A payment arrived after expiry/)).toBeDefined();
  });

  it("refunded: neutral informational state", () => {
    render(
      <CheckoutState
        invoice={{ ...base, status: "refunded", amountPaidSats: "50000" }}
        notFound={false}
      />,
    );
    expect(screen.getByText("Refunded")).toBeDefined();
    expect(screen.getByText(/returned in full/)).toBeDefined();
  });

  it("not found: generic 404 view", () => {
    render(<CheckoutState invoice={null} notFound={true} />);
    expect(screen.getByText("Not found")).toBeDefined();
  });
});

describe("Return to store link", () => {
  const withReturn = { ...base, returnUrl: "https://store.example/thanks/7" };

  it("shows on confirmed, refunded, and expired when returnUrl is set", () => {
    for (const status of ["confirmed", "refunded", "expired"] as const) {
      const { unmount } = render(
        <CheckoutState invoice={{ ...withReturn, status }} notFound={false} />,
      );
      const link = screen.getByText("Return to store →") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("https://store.example/thanks/7");
      unmount();
    }
  });

  it("never shows without a returnUrl, and not on pending even with one", () => {
    const { unmount } = render(
      <CheckoutState invoice={{ ...base, status: "confirmed" }} notFound={false} />,
    );
    expect(screen.queryByText("Return to store →")).toBeNull();
    unmount();

    render(<CheckoutState invoice={withReturn} notFound={false} />);
    expect(screen.queryByText("Return to store →")).toBeNull();
  });
});

describe("deriveView", () => {
  const T = 1_000_000_000_000;
  const openInvoice = { ...base, createdAt: T, expiresAt: T + 10 * 60 * 1000 };

  it("maps payloads to views", () => {
    expect(deriveView(null, true)).toBe("notfound");
    expect(deriveView(null, false)).toBe("loading");
    expect(deriveView(base, false)).toBe("pending");
    expect(deriveView({ ...base, amountPaidSats: "1" }, false)).toBe("partial");
    expect(deriveView({ ...base, status: "paid" }, false)).toBe("paid");
    expect(deriveView({ ...base, status: "confirmed" }, false)).toBe("confirmed");
    expect(deriveView({ ...base, status: "expired" }, false)).toBe("expired");
    expect(deriveView({ ...base, status: "refund_pending" }, false)).toBe("refunded");
    expect(deriveView({ ...base, status: "refunded" }, false)).toBe("refunded");
  });

  it("underpaid renders as the green top-up state WHILE the window is open", () => {
    const inv = { ...openInvoice, status: "underpaid" as const, amountPaidSats: "30000" };
    // one second before expiry → still open → green top-up (partial)
    expect(deriveView(inv, false, inv.expiresAt - 1000)).toBe("partial");
  });

  it("underpaid flips to the amber card once the window has closed", () => {
    const inv = { ...openInvoice, status: "underpaid" as const, amountPaidSats: "30000" };
    // one second after expiry → amber underpaid
    expect(deriveView(inv, false, inv.expiresAt + 1000)).toBe("underpaid");
    // exactly at expiry counts as closed
    expect(deriveView(inv, false, inv.expiresAt)).toBe("underpaid");
  });
});

describe("QR block sizing per state (class-level; pixel truth needs human eyes)", () => {
  // The QR container carries the size class ui.css maps to a FIXED inner size:
  //   .ot-qr → 216px · .ot-qr.is-compact → 176px · .ot-qr.is-pos → 296/220px.
  it("pending uses the default (216px) QR class, not compact or pos", () => {
    const { container } = render(<CheckoutState invoice={base} notFound={false} />);
    const qr = container.querySelector(".ot-qr");
    expect(qr).not.toBeNull();
    expect(qr!.classList.contains("is-compact")).toBe(false);
    expect(qr!.classList.contains("is-pos")).toBe(false);
  });

  it("open-underpaid top-up uses the compact (176px) QR class", () => {
    const openUnderpaid: PublicInvoice = {
      ...base,
      status: "underpaid",
      amountPaidSats: "30000",
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    const { container } = render(<CheckoutState invoice={openUnderpaid} notFound={false} />);
    const qr = container.querySelector(".ot-qr");
    expect(qr).not.toBeNull();
    expect(qr!.classList.contains("is-compact")).toBe(true);
  });

  // Regression: a 64-char Tachi address widened the text column, the grid
  // clamped the QR's width via max-width:100%, and the fixed height stayed:
  // a 32×248 strip at desktop. happy-dom doesn't cascade these stylesheets, so
  // resolve the real rules against the rendered <img> here (specificity +
  // source order + min/max-width media) and check the result per viewport.
  it("pending QR img stays square at every viewport (width and height from one size)", async () => {
    const tachi = "bcrt1p" + "q7x3k9m2v8d4f6h0j5n1s3w7e9r2t4y6u8i0o2p4a6s8d0f2g4h6j8k0l2";
    const { container } = render(
      <CheckoutState invoice={{ ...base, address: tachi, paymentUri: `bitcoin:${tachi}` }} notFound={false} />,
    );
    const img = await waitFor(() => {
      const el = container.querySelector(".ck-root.is-wide .ck-qr-wrap .ot-qr img");
      if (!el) throw new Error("QR img not mounted");
      return el;
    });
    const card = container.querySelector(".ck-card")!;

    // Path from a string, not new URL(): under happy-dom the global URL isn't
    // Node's, and readFileSync silently read this test file instead.
    const shared = join(dirname(fileURLToPath(import.meta.url)), "../src/shared");
    const css = ["ui.css", "checkout.css"]
      .map((f) => readFileSync(join(shared, f), "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    type Rule = { media: string | null; selectors: string[]; decls: Record<string, string> };
    const rules: Rule[] = [];
    const parse = (src: string, media: string | null) => {
      let i = 0;
      while (i < src.length) {
        const open = src.indexOf("{", i);
        if (open < 0) break;
        const head = src.slice(i, open).trim();
        let depth = 1;
        let close = open + 1;
        for (; depth > 0; close++) {
          if (close >= src.length) throw new Error(`unbalanced braces after "${head}"`);
          depth += src[close] === "{" ? 1 : src[close] === "}" ? -1 : 0;
        }
        const body = src.slice(open + 1, close - 1);
        if (head.startsWith("@media")) parse(body, head.slice(6).trim());
        else if (!head.startsWith("@")) {
          const decls: Record<string, string> = {};
          for (const d of body.split(";")) {
            const c = d.indexOf(":");
            if (c > 0) decls[d.slice(0, c).trim()] = d.slice(c + 1).trim();
          }
          rules.push({ media, selectors: head.split(",").map((s) => s.trim()), decls });
        }
        i = close;
      }
    };
    parse(css, null);

    const specificity = (sel: string) =>
      (sel.match(/#[\w-]+/g)?.length ?? 0) * 1e4 +
      (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length ?? 0) * 100 +
      (sel.match(/(^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0);
    const mediaMatches = (m: string | null, vw: number) =>
      m === null ||
      m.split(/\band\b/).every((q) => {
        const px = /\((min|max)-width:\s*(\d+)px\)/.exec(q);
        if (!px) return false; // prefers-reduced-motion etc.: not in effect here
        const limit = Number(px[2]);
        return px[1] === "min" ? vw >= limit : vw <= limit;
      });
    const computed = (el: Element, vw: number) => {
      const hits = rules
        .map((r, order) => ({ r, order, spec: Math.max(-1, ...r.selectors.filter((s) => el.matches(s)).map(specificity)) }))
        .filter((h) => h.spec >= 0 && mediaMatches(h.r.media, vw))
        .sort((a, b) => a.spec - b.spec || a.order - b.order);
      return Object.assign({} as Record<string, string>, ...hits.map((h) => h.r.decls));
    };

    for (const vw of [320, 375, 560, 719, 720, 1024, 1440, 1920]) {
      const s = computed(img, vw);
      expect(s.width, `vw=${vw}`).toMatch(/^\d+px$/);
      // Square by construction: height equals width, or height follows width.
      if (s.height === "auto") expect(s["aspect-ratio"], `vw=${vw}`).toBe("1 / 1");
      else expect(s.height, `vw=${vw}`).toBe(s.width);
      // A width that can be clamped must never sit beside a fixed height.
      if (s["max-width"] && s["max-width"] !== "none") expect(s.height, `vw=${vw}`).toBe("auto");
    }

    // Two-column desktop: the QR renders at 248px, can't be compressed, and the
    // text column can't claim its width.
    const wide = computed(img, 1440);
    expect(wide.width).toBe("248px");
    expect(wide["max-width"]).toBe("none");
    expect(computed(card, 1440)["grid-template-columns"]).toMatch(/^minmax\(0,\s*1fr\)/);
  });
});

describe("underpaid boundary (rendered, live clock)", () => {
  // Fixtures are relative to Date.now() so the live useNow() clock resolves
  // them deterministically regardless of wall-clock date.
  const openUnderpaid: PublicInvoice = {
    ...base,
    status: "underpaid",
    amountPaidSats: "30000",
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 5 * 60 * 1000, // still open
  };
  const closedUnderpaid: PublicInvoice = {
    ...base,
    status: "underpaid",
    amountPaidSats: "30000",
    createdAt: Date.now() - 30 * 60 * 1000,
    expiresAt: Date.now() - 60_000, // closed
  };

  it("still-open underpaid shows the green top-up state, not the amber card", () => {
    render(<CheckoutState invoice={openUnderpaid} notFound={false} />);
    // green well: "X of Y received" + remaining prompt + live top-up affordances
    expect(screen.getByText(/30 000 of 50 000 received/)).toBeDefined();
    expect(screen.getByText(/Send the remaining/)).toBeDefined();
    expect(screen.getByText("ARRIVING")).toBeDefined();
    expect(screen.getByText("COPY")).toBeDefined();
    expect(screen.getByText("Expires in")).toBeDefined();
    // NOT the amber expired copy
    expect(screen.queryByText(/contact them to settle or refund/)).toBeNull();
  });

  it("closed underpaid shows the amber expired-underpaid card", () => {
    render(<CheckoutState invoice={closedUnderpaid} notFound={false} />);
    expect(screen.getByText("UNDERPAID")).toBeDefined();
    expect(screen.getByText(/contact them to settle or refund/)).toBeDefined();
    expect(screen.queryByText(/Send the remaining/)).toBeNull();
  });
});
