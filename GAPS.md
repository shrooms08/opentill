# Known gaps and deliberate deviations

Living list of things OpenTill knowingly does not do (yet), and the reasoning.
Fixed items stay listed with the gate that closed them.

## Fixed

- **Underpaid invoices were terminal** *(Gate 3).* `underpaid → paid` on a
  covering top-up; `confirmed` once every credited payment commits.
- **No exit/withdrawal flow** *(Gate 4, mock).* Cooperative withdrawal and
  unilateral exit implemented end-to-end in the mock adapter + gateway + dashboard.
- **Underpaid-before-expiry copy / POS auto-reset** *(Gate 7).*
- **Mock-only settlement** *(Gate 8).* `ADAPTER_MODE=tachi` is now a real
  adapter: per-invoice addresses, detection, confirmation and refunds are live
  on Tachi regtest ([INTEGRATION.md](INTEGRATION.md), [docs/tachi-e2e-output.md](docs/tachi-e2e-output.md)).

## Open — real (tachi) mode

- **No L1 payouts in real mode — mechanism proven, bridge missing.** The
  Taurus vault path (create → L1 deposit → register → unilateral exit
  `5bb2960b…d0c3` / 5-of-7 co-signed refund `b78cdb62…f86b`) ran for real on
  regtest (`npm run spike:vault`, docs/tachi-vault-spike.md). But registering
  a vault mints no ledger VTXO: invoice receipts (ledger VTXOs) and vault funds
  (L1) are separate pools with no bridge, so wiring it in would let a merchant
  exit only prior L1 deposits, not sales. `initiatePayout` therefore returns a
  `failed` payout with that reason; the mock keeps demonstrating the UX. Open
  question #1 to Tachi (INTEGRATION.md §5) unblocks it in ~a day.
- **Refund needs one key holding `amount + fee`.** A TachiTx has a single
  signer, so funds can't be combined across keys in one send. An invoice key
  holds exactly its amount, so refunds are paid from the till key — keep it
  funded. Consolidation (sweeping invoice keys into the till) is not automated.
- **Ledger onboarding outside regtest is unverified.** Our keys were funded
  via a self-signed `TxDeposit` the regtest daemon accepts without L1 backing;
  the sanctioned signet/mainnet path (presumably vault deposit only) is an open
  question to Tachi (INTEGRATION.md §5).
- **No `watch()` supplement.** Detection is polling only (2 s tick); the
  WebSocket stream was verified but not wired in.
- **Fees are the daemon minimum** (`min_fee_sat`, 1 sat on regtest); no fee
  policy beyond that, and no L1 fee handling at all.
- **On-chain balance is a `scantxoutset` through the RPC proxy** — a full
  UTXO-set scan, cached 60 s; fine for a merchant, not for thousands of keys.
- **State file is the key index.** `TACHI_STATE_PATH` is re-derivable from the
  mnemonic but there is no automated rescan to rebuild it; back it up with the DB.
- **Node ≥ 22 required in tachi mode** (SDK engines); mock mode still runs on 20.
- **Signet untested.** The code path is identical (`TACHI_NETWORK=signet`,
  chain-id check `tachi-signet*`) but only regtest was exercised.

## Open — integrations & deployment

- **WooCommerce sats conversion is a fixed rate**, single currency; refunds are
  initiated from the OpenTill dashboard (WooCommerce follows via webhook).
- **Plugin coverage is lint-only** (no WordPress in tests, deliberately).
- **Docker image runs TypeScript via tsx** rather than precompiled JS.
- **QR canvas colors are code literals** (`Qr.tsx` mirrors the tokens).

## Open — engine & accounting

- **Late payments on expired invoices are recorded but never credited** —
  deliberate; flagged `latePayment: true`, resolution is manual.
- **Refunds always return the full `amountPaidSats`** — no partial refunds.
- **Single tenant.** One API key, one merchant, one storefront name.
- **Stats `confirmedTotalSats` counts `amountPaidSats`** (money received,
  overpayments included), not the invoiced amount.
