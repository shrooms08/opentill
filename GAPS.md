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

- **No L1 payouts in real mode — SDK builders missing, not protocol.** The
  Taurus vault path (create → L1 deposit → register → unilateral exit
  `5bb2960b…d0c3` / 5-of-7 co-signed refund `b78cdb62…f86b`) ran for real on
  regtest (`npm run spike:vault`). Tachi confirms the missing pieces exist on
  the protocol: `TxLockForVault`/`TxUnlockFromVault`, the ledger→vault bridge
  (`TxVaultOpen` alone never touches ledger VTXOs, which is why the spike could
  only exit self-deposited funds). Tachi first pointed us at `TxWithdraw` as a
  simpler vault-free exit, then inspected their source and retracted it: the type
  is **unimplemented** beyond generic format checks — no L1 broadcast, no
  destination semantics — so a payout built on it would commit and move nothing
  while appearing to succeed. The shipped TS SDK has no builder for
  `TxLockForVault`, but its wire contract is now specified (finalized PSBT with
  exactly one P2TR output in `PSBTPayload`), so it is ours to build and verify
  rather than blocked on Tachi — `npm run spike:lock`.
  `initiatePayout` therefore returns a `failed` payout with that reason; the
  mock keeps demonstrating the UX. With a builder, wiring is a short job on the
  adapter's existing build → sign → broadcast → assert `code 0` → commit path.
- **Vault liveness must be self-observed.** `TxVaultClose` is defined but not
  wired; the daemon reports every vault as `"open"` forever. A real-mode payout
  feature must detect exit-leaf spends from its own L1 observation.
- **CSV default must be 1008, not the spike's 1.** No protocol minimum exists;
  `csvBlocks=1` was accepted only because nothing stops it. A product default
  of 1008 blocks (~7 days) is conventional; the true lower bound is the
  operator's monitoring latency.
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
