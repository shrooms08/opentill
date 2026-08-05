// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PayoutDTO } from "@opentill/shared";
import { ExitBanner, OverviewView } from "../src/dashboard/views/Overview";
import { PayoutsView, PayoutTable, WithdrawForm } from "../src/dashboard/views/Payouts";

const NOW = 1_770_000_000_000;

const basePayout: PayoutDTO = {
  id: "po_fixture1",
  payoutId: "mockpo_abc",
  kind: "cooperative",
  toAddress: "bc1qmerchantcoldstoragexyz",
  amountSats: "30000",
  status: "initiated",
  timelockBlocksRemaining: null,
  txId: null,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
  settledAt: null,
};

const pendingExit: PayoutDTO = {
  ...basePayout,
  id: "po_exit1",
  payoutId: "mockpo_exit",
  kind: "exit",
  amountSats: "80000",
  status: "waiting_timelock",
  timelockBlocksRemaining: 7,
  txId: "mocktx_exitbroadcast",
};

const balance = { offchainSats: "80000", onchainSats: "20000" };

afterEach(cleanup);

describe("PayoutTable", () => {
  it("shows the empty state", () => {
    render(<PayoutTable payouts={[]} />);
    expect(screen.getByText(/No payouts yet/)).toBeDefined();
  });

  it("renders cooperative pending, exit countdown, settled, and failed rows", () => {
    render(
      <PayoutTable
        payouts={[
          basePayout,
          { ...basePayout, id: "po_2", payoutId: "p2", status: "broadcasting", txId: "mocktx_b" },
          pendingExit,
          {
            ...basePayout,
            id: "po_3",
            payoutId: "p3",
            status: "settled",
            txId: "mocktx_s",
            settledAt: NOW,
          },
          {
            ...basePayout,
            id: "po_4",
            payoutId: "p4",
            status: "failed",
            error: "balance 100 sats < requested 30000 sats",
          },
        ]}
      />,
    );
    expect(screen.getByText("initiated")).toBeDefined();
    expect(screen.getByText("broadcasting")).toBeDefined();
    expect(screen.getByText("waiting timelock")).toBeDefined();
    expect(screen.getByText("7 blocks")).toBeDefined();
    expect(screen.getByText("settled")).toBeDefined();
    expect(screen.getByText("failed")).toBeDefined();
    expect(screen.getByText(/balance 100 sats/)).toBeDefined();
    expect(screen.getByText("Unilateral exit")).toBeDefined();
    expect(screen.getAllByText("Cooperative").length).toBe(4);
    expect(screen.getAllByText("30 000").length).toBeGreaterThan(0);
  });
});

describe("WithdrawForm", () => {
  it("presents both kinds as honest option cards and gates the submit", () => {
    const onWithdraw = vi.fn(async () => ({ ok: true }));
    render(<WithdrawForm balance={balance} pendingExit={null} onWithdraw={onWithdraw} />);

    expect(screen.getByText("Cooperative withdrawal")).toBeDefined();
    expect(screen.getByText(/escape hatch. It always works/)).toBeDefined();

    const submit = screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // MAX fills the spendable balance.
    fireEvent.click(screen.getByText("MAX"));
    expect((screen.getByLabelText("Amount in sats") as HTMLInputElement).value).toBe("80000");

    fireEvent.change(screen.getByLabelText("Destination Bitcoin address"), {
      target: { value: "bc1qcold" },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onWithdraw).toHaveBeenCalledWith({
      kind: "cooperative",
      toAddress: "bc1qcold",
      amountSats: "80000",
    });
  });

  it("exit path requires an explicit confirmation restating the sweep", async () => {
    const onWithdraw = vi.fn(async () => ({ ok: true }));
    render(<WithdrawForm balance={balance} pendingExit={null} onWithdraw={onWithdraw} />);

    fireEvent.click(screen.getByText("Unilateral exit"));
    fireEvent.change(screen.getByLabelText("Destination Bitcoin address"), {
      target: { value: "bc1qsovereign" },
    });
    fireEvent.click(screen.getByText("Start unilateral exit…"));

    // Confirmation step: restates the amount and the spending lock. Nothing sent yet.
    expect(onWithdraw).not.toHaveBeenCalled();
    expect(screen.getByText(/entire off-chain balance/)).toBeDefined();
    expect(screen.getByText("80 000 sats")).toBeDefined();
    expect(screen.getByText(/spending from this balance is locked/)).toBeDefined();

    fireEvent.click(screen.getByText("Exit now"));
    expect(onWithdraw).toHaveBeenCalledWith({ kind: "exit", toAddress: "bc1qsovereign" });
    expect(await screen.findByText("Payout initiated ✓")).toBeDefined();
  });

  it("locks the form while an exit is pending", () => {
    render(
      <WithdrawForm balance={balance} pendingExit={pendingExit} onWithdraw={async () => ({ ok: true })} />,
    );
    expect(screen.getByText(/withdrawals unlock when it settles/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PayoutsView balance header", () => {
  it("adds the exiting line while an exit is pending", () => {
    render(
      <PayoutsView
        payouts={[pendingExit]}
        balance={{ offchainSats: "0", onchainSats: "20000" }}
        onWithdraw={async () => ({ ok: true })}
      />,
    );
    expect(screen.getByText("Spendable now · off-chain")).toBeDefined();
    expect(screen.getByText("On-chain · settled")).toBeDefined();
    expect(screen.getByText(/exiting · 7 blocks remaining/)).toBeDefined();
    expect(screen.getByText(/80 000 sats in flight/)).toBeDefined();
  });
});

describe("Overview exit banner", () => {
  it("shows a countdown banner when an exit is pending", () => {
    render(
      <OverviewView stats={null} balance={null} recent={null} pendingExit={pendingExit} />,
    );
    expect(screen.getByText(/Unilateral exit in progress/)).toBeDefined();
    expect(screen.getAllByText(/7 blocks remaining/).length).toBeGreaterThan(0);
    expect(screen.getByText(/spending is locked until it settles/)).toBeDefined();
  });

  it("renders no banner otherwise", () => {
    render(<OverviewView stats={null} balance={null} recent={null} pendingExit={null} />);
    expect(screen.queryByText(/Unilateral exit in progress/)).toBeNull();
  });
});

describe("ExitBanner", () => {
  it("states amount and blocks plainly", () => {
    render(<ExitBanner exit={pendingExit} />);
    expect(screen.getByText(/80 000 sats/)).toBeDefined();
  });
});
