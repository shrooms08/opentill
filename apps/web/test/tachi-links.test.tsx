// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ExplorerLinks, InvoiceDTO } from "@opentill/shared";
import { CheckoutState } from "../src/shared/CheckoutState";
import { explorerAddressUrl, explorerTxUrl } from "../src/shared/explorer";
import { SettlementContext, type SettlementInfo } from "../src/dashboard/settlement";
import { InvoiceDetailView } from "../src/dashboard/views/InvoiceDetail";
import { BalanceHeroes } from "../src/dashboard/views/Overview";
import { PayoutsView } from "../src/dashboard/views/Payouts";
import type { InvoiceWithPayments } from "../src/dashboard/api";
import type { PublicInvoice } from "../src/shared/types";

vi.mock("qrcode", () => ({
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,iVBORw0KGgo=") },
}));

const NOW = 1_770_000_000_000;
const RPC = "https://rpc-regtest.tachibtc.com";
const explorer: ExplorerLinks = {
  txUrl: `${RPC}/tachi_tx?hash={hash}`,
  addressUrl: `${RPC}/tachi_addressVtxos?address={address}&include_spent=true`,
};
const ADDR = "bcrt1pinvoiceaddress";
const TX = "966110f46e8ff371562620e19cbd537fca6010b2dbb6dea88b88d720e0034f3e";
const REFUND_TX = "d5fa7587f471ca72b4e6ea07d9569aa740c05eeaff736f6b7379634187cfbef2";

const publicInvoice: PublicInvoice = {
  id: "inv_links",
  status: "confirmed",
  amountSats: "2000",
  amountPaidSats: "2000",
  memo: null,
  address: ADDR,
  paymentUri: `bitcoin:${ADDR}?amount=0.00002`,
  merchantName: "OpenTill",
  createdAt: NOW,
  expiresAt: NOW + 900_000,
  latePayment: false,
  devSimulate: false,
  returnUrl: null,
  paymentTxIds: [TX],
  explorer,
};

const invoice: InvoiceDTO = {
  id: "inv_links",
  status: "refunded",
  amountSats: "2000",
  amountPaidSats: "2000",
  shortfallSats: null,
  address: ADDR,
  paymentUri: publicInvoice.paymentUri,
  checkoutUrl: null,
  memo: null,
  orderId: null,
  webhookUrl: null,
  returnUrl: null,
  refundAddress: "bcrt1pcustomer",
  refundTxId: REFUND_TX,
  refundError: null,
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: NOW + 900_000,
  confirmedAt: NOW,
};

const detail: InvoiceWithPayments = {
  ...invoice,
  payments: [
    { paymentId: "v1", invoiceId: invoice.id, address: ADDR, amountSats: "1500", status: "committed", latePayment: false, txId: TX, observedAt: NOW },
    { paymentId: "v2", invoiceId: invoice.id, address: ADDR, amountSats: "500", status: "committed", latePayment: false, txId: null, observedAt: NOW },
  ],
};

const tachi: SettlementInfo = { adapterMode: "tachi", explorer, demoUrl: "https://demo.example" };
const mock: SettlementInfo = { adapterMode: "mock", explorer: null, demoUrl: null };

const hrefs = () =>
  screen.queryAllByRole("link").map((a) => ({ text: a.textContent, href: a.getAttribute("href"), target: a.getAttribute("target") }));

afterEach(cleanup);

describe("explorer templates", () => {
  it("fills {hash} and {address}", () => {
    expect(explorerTxUrl(explorer, TX)).toBe(`${RPC}/tachi_tx?hash=${TX}`);
    expect(explorerAddressUrl(explorer, ADDR)).toBe(`${RPC}/tachi_addressVtxos?address=${ADDR}&include_spent=true`);
  });
});

describe("checkout: View on Tachi", () => {
  it("links the payment tx on a confirmed invoice, in a new tab", () => {
    render(<CheckoutState invoice={publicInvoice} notFound={false} />);
    const link = screen.getByText("View on Tachi ↗");
    expect(link.getAttribute("href")).toBe(`${RPC}/tachi_tx?hash=${TX}`);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("falls back to the invoice address while paid without a known txid", () => {
    render(<CheckoutState invoice={{ ...publicInvoice, status: "paid", paymentTxIds: [] }} notFound={false} />);
    expect(screen.getByText("View on Tachi ↗").getAttribute("href")).toContain(`address=${ADDR}`);
  });

  it("shows no link in mock mode or before payment", () => {
    render(<CheckoutState invoice={{ ...publicInvoice, explorer: null }} notFound={false} />);
    expect(screen.queryByText(/on Tachi/)).toBeNull();
    cleanup();
    render(<CheckoutState invoice={{ ...publicInvoice, status: "pending", amountPaidSats: "0", paymentTxIds: [] }} notFound={false} />);
    expect(screen.queryByText(/on Tachi/)).toBeNull();
  });
});

describe("dashboard: View on Tachi", () => {
  const renderDetail = (s: SettlementInfo) =>
    render(
      <SettlementContext.Provider value={s}>
        <InvoiceDetailView invoice={detail} deliveries={[]} onClose={() => {}} onRefund={async () => ({ ok: true })} onRetry={() => {}} />
      </SettlementContext.Provider>,
    );

  it("invoice detail links the address, each payment tx (or its address) and the refund tx", () => {
    renderDetail(tachi);
    const links = hrefs();
    expect(links).toContainEqual({ text: "View tx ↗", href: `${RPC}/tachi_tx?hash=${TX}`, target: "_blank" });
    expect(links).toContainEqual({ text: "View address ↗", href: explorerAddressUrl(explorer, ADDR), target: "_blank" });
    expect(links).toContainEqual({ text: "View on Tachi ↗", href: `${RPC}/tachi_tx?hash=${REFUND_TX}`, target: "_blank" });
    expect(links).toContainEqual({ text: "View on Tachi ↗", href: explorerAddressUrl(explorer, ADDR), target: "_blank" });
  });

  it("invoice detail has no Tachi links in mock mode", () => {
    renderDetail(mock);
    expect(screen.queryByText(/View (tx|address|on Tachi)/)).toBeNull();
  });

  it("balance card links the till address in tachi mode only", () => {
    const balance = { offchainSats: "100000", onchainSats: "0", tillAddress: "bcrt1ptill" };
    render(
      <SettlementContext.Provider value={tachi}>
        <BalanceHeroes balance={balance} />
      </SettlementContext.Provider>,
    );
    expect(screen.getByText("View till on Tachi ↗").getAttribute("href")).toBe(explorerAddressUrl(explorer, "bcrt1ptill"));
    cleanup();
    render(
      <SettlementContext.Provider value={mock}>
        <BalanceHeroes balance={{ ...balance, tillAddress: null }} />
      </SettlementContext.Provider>,
    );
    expect(screen.queryByText(/on Tachi/)).toBeNull();
  });
});

describe("Payouts in tachi mode", () => {
  const renderPayouts = (s: SettlementInfo) =>
    render(
      <SettlementContext.Provider value={s}>
        <PayoutsView payouts={[]} balance={{ offchainSats: "100000", onchainSats: "0" }} onWithdraw={async () => ({ ok: true })} />
      </SettlementContext.Provider>,
    );

  it("replaces the withdraw actions with the coming-with-exit card and a demo link", () => {
    renderPayouts(tachi);
    expect(screen.getByText("On-chain payouts: coming with Tachi exit support")).toBeDefined();
    expect(screen.getByText(/Received sats stay self-custodial on Tachi/)).toBeDefined();
    expect(screen.queryByText("Cooperative withdrawal")).toBeNull();
    expect(screen.queryByRole("button", { name: /Withdraw|exit/i })).toBeNull();
    const demo = screen.getByText(/payout flow on the demo instance/);
    expect(demo.getAttribute("href")).toBe("https://demo.example/dashboard#/payouts");
    expect(demo.getAttribute("target")).toBe("_blank");
  });

  it("keeps the withdraw form in mock mode", () => {
    renderPayouts(mock);
    expect(screen.queryByText(/coming with Tachi exit support/)).toBeNull();
    expect(screen.getByText("Cooperative withdrawal")).toBeDefined();
  });
});
