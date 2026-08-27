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

- **No L1 payouts in real mode — the protocol has no ledger→L1 path for
  receipts today.** Tachi traced every candidate in source (INTEGRATION.md
  §5.3b/5.3e/5.4): `TxWithdraw` has no handler; `TxLockForVault`/`TxUnlockFromVault`
  only flip a `Locked` flag on a VTXO after parsing the PSBT for the vault
  address — no L1 activity; nothing pays out on L1 against a locked VTXO —
  "a real gap, not a hidden design choice." The vault exits we proved
  (`5bb2960b…d0c3` unilateral, `b78cdb62…f86b` co-signed) move a vault's own
  L1 funding UTXO, which is why they only worked for self-deposited funds;
  locking a receipt would create no L1 value to exit. Not an SDK-builder gap,
  not ours. `initiatePayout` returns a `failed` payout with this reason; the
  mock demonstrates the intended UX. Unblocked only by Tachi shipping
  ledger→L1 offboarding, at which point the adapter's existing broadcast path
  and the proven vault exits are the pieces it slots into.
- **Reference for whoever wires the lock later** (INTEGRATION.md §5.3e):
  `code 12` after signature = cross-check of TachiTx fields against the parsed
  PSBT (input count, per-input txid/vout, output count, byte-exact output
  amounts); `Outputs` non-empty with `Amount > 0` equal to the PSBT output,
  `Owner` = the VTXO's existing x-only owner; no cooperative-leaf or
  value-equals-VTXO requirement.
- **Refund needs one key holding `amount + fee`.** A TachiTx has a single
  signer, so funds can't be combined across keys in one send. An invoice key
  holds exactly its amount, so refunds are paid from the till key — keep it
  funded. Consolidation (sweeping invoice keys into the till) is not automated.
- **Mainnet deposits need L1 backing + validator attestation.** Self-signed
  `TxDeposit`s are sanctioned on regtest and signet (Tachi: the L1 verification
  gate is mainnet-only), so `npm run fund:tachi` is legitimate testnet behavior.
  On mainnet the adapter would have to: reference a real on-chain deposit whose
  amount and block height/timestamp match exactly, and treat the deposit as
  credited only after validator attestations clear the threshold — not on
  broadcast `code 0`. Neither the attestation wait nor its status surface is
  implemented; the mainnet deposit flow is unexercised.
- **Signet is untested but feasible.** Same code path and same funding approach
  as regtest (`TACHI_NETWORK=signet`); only regtest has been run.
- **No `watch()` supplement.** Detection is polling only (2 s tick); the
  WebSocket stream was verified but not wired in.
- **Fees are the daemon minimum** (`min_fee_sat`, 1 sat on regtest); no fee
  policy beyond that, and no L1 fee handling at all.
- **On-chain balance is a `scantxoutset` through the RPC proxy** — a full
  UTXO-set scan, cached 60 s; fine for a merchant, not for thousands of keys.
- **State file is the key index.** `TACHI_STATE_PATH` is re-derivable from the
  mnemonic but there is no automated rescan to rebuild it; back it up with the DB.
- **Node ≥ 22 required in tachi mode** (SDK engines); mock mode still runs on 20.

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
