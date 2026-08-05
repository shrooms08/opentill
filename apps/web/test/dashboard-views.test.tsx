// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { InvoiceDTO, StatsDTO, WebhookDeliveryDTO } from "@opentill/shared";
import { MockModeBanner } from "../src/dashboard/App";
import { OverviewView } from "../src/dashboard/views/Overview";
import { InvoicesView } from "../src/dashboard/views/Invoices";
import {
  InvoiceDetailView,
  refundDisabledReason,
  RefundFlow,
} from "../src/dashboard/views/InvoiceDetail";
import { PosForm, PosLive } from "../src/dashboard/views/Pos";
import type { InvoiceWithPayments } from "../src/dashboard/api";
import type { PublicInvoice } from "../src/shared/types";

const NOW = 1_770_000_000_000;

const stats: StatsDTO = {
  confirmedCount: 12,
  confirmedTotalSats: "1250000",
  pendingCount: 3,
  refundedCount: 2,
  refundedTotalSats: "40000",
  underpaidCount: 1,
  expiredCount: 4,
  last24h: { confirmedCount: 5, confirmedTotalSats: "300000" },
};

const invoice: InvoiceDTO = {
  id: "inv_fixture1234567890",
  status: "confirmed",
  amountSats: "50000",
  amountPaidSats: "50000",
  shortfallSats: null,
  address: "mock1pfixture",
  paymentUri: "bitcoin:mock1pfixture?amount=0.0005",
  memo: "Flat white",
  orderId: "ORD-9",
  webhookUrl: "https://merchant.example/hook",
  returnUrl: null,
  refundAddress: null,
  refundTxId: null,
  refundError: null,
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: NOW + 900_000,
  confirmedAt: NOW + 60_000,
};

const detailInvoice: InvoiceWithPayments = {
  ...invoice,
  payments: [
    {
      paymentId: "mockpay_aaaaaaaaaaaaaaaa",
      invoiceId: invoice.id,
      address: invoice.address,
      amountSats: "50000",
      status: "committed",
      latePayment: false,
      observedAt: NOW,
    },
  ],
};

const failedDelivery: WebhookDeliveryDTO = {
  id: "whd_fail1",
  invoiceId: invoice.id,
  payoutId: null,
  url: "https://merchant.example/hook?…",
  status: "failed",
  attempts: 5,
  nextAttemptAt: NOW,
  lastStatusCode: 500,
  lastError: "non-2xx response: 500",
  createdAt: NOW,
  updatedAt: NOW,
};

const posFixture: PublicInvoice = {
  id: invoice.id,
  status: "pending",
  amountSats: "50000",
  amountPaidSats: "0",
  memo: null,
  address: invoice.address,
  paymentUri: invoice.paymentUri,
  merchantName: "OpenTill",
  createdAt: NOW,
  expiresAt: NOW + 900_000,
  latePayment: false,
  devSimulate: false,
  returnUrl: null,
};

afterEach(cleanup);

describe("OverviewView", () => {
  it("renders stat cards, labeled balance, and recent invoices", () => {
    render(
      <OverviewView
        stats={stats}
        balance={{ offchainSats: "123456", onchainSats: "0" }}
        recent={[invoice]}
      />,
    );
    expect(screen.getByText("All-time confirmed")).toBeDefined();
    expect(screen.getByText("1 250 000")).toBeDefined();
    expect(screen.getByText("300 000")).toBeDefined();
    expect(screen.getByText("sats · 12 invoices")).toBeDefined();
    expect(screen.getByText("Spendable now · off-chain")).toBeDefined();
    expect(screen.getByText("On-chain · settled")).toBeDefined();
    expect(screen.getByText("123 456")).toBeDefined();
    expect(screen.getByText("Flat white")).toBeDefined();
  });

  it("shows the empty state without invoices", () => {
    render(<OverviewView stats={stats} balance={null} recent={[]} />);
    expect(screen.getByText("Nothing yet")).toBeDefined();
    expect(screen.getByText(/Create your first charge and it will land here/)).toBeDefined();
  });
});

describe("InvoicesView", () => {
  const baseProps = {
    activeTab: 0,
    onTab: () => {},
    q: "",
    onQ: () => {},
    page: 0,
    pageSize: 25,
    onPage: () => {},
  };

  it("renders rows with status pills and pagination", () => {
    render(
      <InvoicesView
        {...baseProps}
        data={{
          invoices: [invoice, { ...invoice, id: "inv_second9876543210", status: "underpaid" }],
          total: 60,
          limit: 25,
          offset: 0,
        }}
      />,
    );
    expect(screen.getByText("inv_fixture1…")).toBeDefined();
    expect(screen.getByText("confirmed")).toBeDefined();
    expect(screen.getByText("underpaid")).toBeDefined();
    expect(screen.getByText("Showing 1–2 of 60")).toBeDefined();
    expect(screen.getAllByText("50 000").length).toBeGreaterThan(0);
  });

  it("shows the filtered empty state", () => {
    render(
      <InvoicesView
        {...baseProps}
        q="nope"
        data={{ invoices: [], total: 0, limit: 25, offset: 0 }}
      />,
    );
    expect(screen.getByText("Nothing matches this filter.")).toBeDefined();
  });
});

describe("InvoiceDetailView", () => {
  it("renders fields, payments, deliveries with retry only on failed ones", () => {
    render(
      <InvoiceDetailView
        invoice={detailInvoice}
        deliveries={[failedDelivery, { ...failedDelivery, id: "whd_ok", status: "delivered" }]}
        onClose={() => {}}
        onRefund={async () => ({ ok: true })}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText("mockpay_aaaaaa…")).toBeDefined();
    expect(screen.getByText("committed")).toBeDefined();
    expect(screen.getByText("failed")).toBeDefined();
    expect(screen.getByText("delivered")).toBeDefined();
    // exactly one retry button — only the failed delivery gets one
    expect(screen.getAllByText("Retry")).toHaveLength(1);
    expect(screen.getByText("Open checkout ↗")).toBeDefined();
  });

  it("explains why refunds are disabled for every non-confirmed status", () => {
    expect(refundDisabledReason("confirmed")).toBeNull();
    for (const status of [
      "pending",
      "paid",
      "underpaid",
      "expired",
      "refund_pending",
      "refunded",
    ] as const) {
      expect(refundDisabledReason(status)).toBeTruthy();
    }

    render(
      <InvoiceDetailView
        invoice={{ ...detailInvoice, status: "pending" }}
        deliveries={[]}
        onClose={() => {}}
        onRefund={async () => ({ ok: true })}
        onRetry={() => {}}
      />,
    );
    const refundButton = screen.getByRole("button", { name: "Refund unavailable" }) as HTMLButtonElement;
    expect(refundButton.disabled).toBe(true);
    expect(screen.getByText("Nothing to refund — no confirmed payment yet.")).toBeDefined();
  });

  it("walks the refund flow: confirm step shows the amount to return", async () => {
    const onRefund = vi.fn(async () => ({ ok: true, txId: "mocktx_1" }));
    render(<RefundFlow invoice={detailInvoice} onRefund={onRefund} />);

    fireEvent.click(screen.getByText("Refund 50 000 sats…"));
    expect(screen.getByText("Refund this invoice")).toBeDefined();
    expect((screen.getByLabelText("Amount to return") as HTMLInputElement).value).toBe("50\u2009000");

    const confirm = screen.getByText("Send refund") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // empty address

    fireEvent.change(screen.getByPlaceholderText("tachi1q… or bc1q…"), {
      target: { value: "  mock1pcustomer  " },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    expect(await screen.findByText("Refund sent")).toBeDefined();
    expect(onRefund).toHaveBeenCalledWith("mock1pcustomer"); // trimmed
  });
});

describe("POS", () => {
  it("form: live BTC conversion, create disabled until a valid amount", () => {
    const onCreate = vi.fn();
    render(<PosForm onCreate={onCreate} />);

    const button = screen.getByText("Create charge") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("— BTC")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Amount in sats"), { target: { value: "50000" } });
    expect(screen.getByText("≈ 0.00050000 BTC")).toBeDefined();
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledWith("50000", "");
  });

  it("live screen: pending shows cancel, confirmed shows the New charge reset", () => {
    const publicInvoice: PublicInvoice = {
      id: invoice.id,
      status: "pending",
      amountSats: "50000",
      amountPaidSats: "0",
      memo: null,
      address: invoice.address,
      paymentUri: invoice.paymentUri,
      merchantName: "OpenTill",
      createdAt: NOW,
      expiresAt: NOW + 900_000,
      latePayment: false,
      devSimulate: false,
      returnUrl: null,
    };

    const { container, unmount } = render(
      <PosLive invoice={publicInvoice} notFound={false} onReset={() => {}} />,
    );
    expect(screen.getByText("Cancel")).toBeDefined();
    expect(screen.queryByText("New charge")).toBeNull();
    // POS step-2 QR carries the pos size class (296px tablet / 220px phone).
    expect(container.querySelector(".ot-qr")?.classList.contains("is-pos")).toBe(true);
    unmount();

    const onReset = vi.fn();
    render(
      <PosLive
        invoice={{ ...publicInvoice, status: "confirmed", amountPaidSats: "50000" }}
        notFound={false}
        onReset={onReset}
      />,
    );
    expect(screen.getByText("Paid")).toBeDefined();
    const reset = screen.getByText("New charge");
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("confirmed flood auto-resets after 8s (fake timers)", () => {
    vi.useFakeTimers();
    try {
      const onReset = vi.fn();
      const confirmed: PublicInvoice = {
        ...posFixture,
        status: "confirmed",
        amountPaidSats: "50000",
      };
      render(<PosLive invoice={confirmed} notFound={false} onReset={onReset} />);

      act(() => void vi.advanceTimersByTime(7_900));
      expect(onReset).not.toHaveBeenCalled(); // not yet
      act(() => void vi.advanceTimersByTime(200));
      expect(onReset).toHaveBeenCalledTimes(1); // fired at 8s
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("tapping New charge cancels the pending auto-reset (no double fire)", () => {
    vi.useFakeTimers();
    try {
      const onReset = vi.fn();
      const confirmed: PublicInvoice = {
        ...posFixture,
        status: "confirmed",
        amountPaidSats: "50000",
      };
      render(<PosLive invoice={confirmed} notFound={false} onReset={onReset} />);

      act(() => void vi.advanceTimersByTime(3_000));
      fireEvent.click(screen.getByText("New charge"));
      expect(onReset).toHaveBeenCalledTimes(1); // immediate
      act(() => void vi.advanceTimersByTime(10_000));
      expect(onReset).toHaveBeenCalledTimes(1); // auto-reset was cancelled
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("MockModeBanner", () => {
  it("shows the mock settlement bar only when adapterMode is mock", () => {
    const { unmount } = render(<MockModeBanner adapterMode="mock" />);
    expect(screen.getByText(/Mock settlement mode/)).toBeDefined();
    expect(screen.getByText(/INTEGRATION\.md/)).toBeDefined();
    unmount();
  });

  it("renders nothing for a real adapter or before the health probe resolves", () => {
    const { unmount } = render(<MockModeBanner adapterMode="tachi" />);
    expect(screen.queryByText(/Mock settlement mode/)).toBeNull();
    unmount();

    render(<MockModeBanner adapterMode={null} />);
    expect(screen.queryByText(/Mock settlement mode/)).toBeNull();
  });
});
