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

- **No L1 payouts in real mode — one transaction type plus one design answer.**
  Everything around the lock step is proven on regtest: ledger receive/transfer/
  refund, `TxVaultOpen`, the 5-of-7 co-signed cooperative refund
  (`b78cdb62…f86b`) and the user-only unilateral exit (`5bb2960b…d0c3`)
  (`npm run spike:vault`). The join — `TxLockForVault`, the ledger→vault
  bridge for merchant-receipt VTXOs — is **blocked**: 15 conforming shapes were
  rejected with `code 12` by a post-signature rule the daemon does not name
  (`npm run spike:lock`, docs/tachi-lock-spike.md); a bogus-signature probe
  showed `Outputs` must be non-empty and that the envelope otherwise passes the
  generic format check, and `/tachi_txDecode` parses it as `lock`. Pending
  Tachi's post-signature rules or a byte-exact example. `TxWithdraw` is not an
  alternative — Tachi found it unimplemented beyond format checks (a payout on
  it would commit and move nothing). Open design question even after the lock
  works: whether a locked receipt's L1 payout is backed by the vault's own
  funding (merchant pre-funds) or network liquidity. `initiatePayout` returns a
  `failed` payout with this reason; the mock keeps demonstrating the UX. With
  the lock rule known, wiring is ~a day on the adapter's existing
  build → sign → broadcast → assert `code 0` → commit path.
- **`/tachi_txValidate` is unusable** — rejects valid transfers with a decoder
  error; only broadcast verdicts count.
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
