# Known gaps and deliberate deviations

Living list of things OpenTill knowingly does not do (yet), and the reasoning.
Fixed items stay listed with the gate that closed them.

## Fixed

- **Underpaid invoices were terminal** *(Gate 1 deviation — fixed in Gate 3).*
  Payments landing on an `underpaid` invoice used to credit `amountPaidSats`
  without ever transitioning. Now a credit bringing the cumulative total to
  `>= amountSats` moves `underpaid → paid`, and `paid → confirmed` fires once
  **every** credited (non-late) payment has committed — see `maybeConfirm` in
  [invoices.ts](packages/gateway/src/domain/invoices.ts) and
  [gate3.test.ts](packages/gateway/test/gate3.test.ts).
- **No exit/withdrawal flow** *(fixed in Gate 4).* Cooperative withdrawal and
  unilateral exit are implemented end-to-end (adapter, gateway, dashboard) —
  see [gate4.test.ts](packages/gateway/test/gate4.test.ts).
- **Underpaid-before-expiry showed the wrong copy** *(fixed in Gate 7).* The
  amber "the invoice expired before the full amount arrived" card rendered the
  moment a short payment landed — false while the window was still open. The
  checkout now shows the green top-up state until `now >= expiresAt`, then the
  amber card. Presentational, clock-driven; no state-machine change. See the
  boundary tests in [checkout-states.test.tsx](apps/web/test/checkout-states.test.tsx).
- **No POS auto-reset** *(fixed in Gate 7).* The confirmed POS flood now
  auto-resets to step 1 after 8s (design 05); tapping "New charge" cancels the
  timer. Component tests with fake timers in
  [dashboard-views.test.tsx](apps/web/test/dashboard-views.test.tsx).

## Open

### Settlement (the headline limitation)

- **Ships in mock settlement mode — no real Bitcoin moves.** `ADAPTER_MODE=mock`
  simulates Tachi deterministically. The real adapter
  ([tachi.ts](packages/adapter/src/tachi.ts)) is a compiling scaffold; as of
  2026-07-22 Tachi answered **Q1 co-signing** (the node co-signs on broadcast —
  the send path is now spec-complete) and **Q3** partially (vaults are created
  against Tachi's hosted node, not a local validator set), leaving **Q2
  receiver-side VTXO detection** as the one open design question; the rest waits
  on Tachi's published endpoints (target 2026-08-15). `ADAPTER_MODE=tachi`
  constructs the adapter but `init()` refuses with a pointer to
  [INTEGRATION.md](INTEGRATION.md). Mock mode is labeled everywhere (dashboard
  footer, `/healthz`).

### Payouts (things real Tachi will force us to revisit)

- **No on-chain fee estimation or fee handling anywhere.** The mock ignores fees.
  A real unilateral exit needs fee management for the pre-signed exit tx (anchor
  outputs / CPFP, possibly RBF) — the exit tx is signed long before broadcast, so
  its feerate cannot be known in advance.
- **No partial exits.** Exit is all-or-nothing (the whole vault leaf). Real Tachi
  vault trees may allow exiting a subtree.
- **Deposits during an exit are naively credited.** Money arriving mid-sweep just
  lands in `offchainSats`; real behavior depends on how Tachi handles new VTXOs
  against a vault mid-exit.
- **Fixed mock timelock (12 blocks).** The real timelock comes from the vault
  script and must be read from the chain.
- **One global payout webhook URL** (not per-payout) — payouts are
  merchant-initiated, so the merchant already knows about them.
- **Exit cannot fail in the mock.** `failed` exists in the state machine but the
  mock never produces it for exits (real broadcasts can be stuck/orphaned).

### Integrations & deployment

- **WooCommerce sats conversion is a fixed rate**, no live BTC/fiat feed;
  single currency per store. Refunds are initiated from the OpenTill dashboard,
  not WP admin (WooCommerce follows via the `refunded` webhook).
- **Plugin coverage is lint-only** (no WordPress in tests, deliberately); the
  HMAC scheme and payloads are contract-tested on the gateway side.
- **Docker image runs TypeScript via tsx** rather than precompiled JS — a
  simplicity tradeoff; a build-to-dist step would shave image size/cold-start.
- **QR canvas colors are code literals.** `qrcode` paints a canvas and needs
  concrete values; the two literals in [Qr.tsx](apps/web/src/shared/Qr.tsx)
  mirror `--ot-ink`/`--ot-sheet` but cannot consume CSS variables.

### Engine & accounting

- **Late payments on expired invoices are recorded but never credited** —
  deliberate; flagged `latePayment: true`, resolution is manual.
- **Refunds always return the full `amountPaidSats`** — no partial refunds; no
  destination-address validation beyond non-empty (the real adapter brings
  address parsing).
- **Single tenant.** One API key, one merchant, one storefront name.
  Multi-tenancy is out of scope for the self-hosted pitch.
- **Stats `confirmedTotalSats` counts `amountPaidSats`** (money received,
  overpayments included), not the invoiced amount.
