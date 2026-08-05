<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <img src="docs/brand/lockup-light.svg" alt="OpenTill" width="360">
</picture>

OpenTill is a self-hosted Bitcoin payment gateway: one container that takes payments on the Tachi network (off-chain vaults backed by real on-chain Bitcoin), shows your customers a hosted checkout page, and gives you a merchant dashboard with a built-in point-of-sale. Your keys, your server, your money — including a unilateral exit that turns your balance back into plain on-chain Bitcoin without anyone's permission. It plugs into WooCommerce out of the box, and into anything else through a small JSON API with HMAC-signed webhooks.

```
                 ┌──────────────────────────── OpenTill (one process) ───────────────────────────┐
                 │                                                                               │
 customer ──────▶│  /pay/:id      hosted checkout (QR, live status via SSE)                      │
 merchant ──────▶│  /dashboard    overview · invoices · refunds · POS · payouts/exit             │
 your backend ──▶│  /api/*        invoices · refunds · stats · payouts  (Bearer API key)         │
                 │                                                                               │
                 │   Fastify ── SQLite (WAL) ── pollers ──▶ TachiAdapter ──▶ Tachi network       │
                 │      │                                    (mock today)    (vaults / VTXOs)    │
                 │      └──▶ HMAC-signed webhooks ──▶ your store (WooCommerce plugin, any HTTP)  │
                 └───────────────────────────────────────────────────────────────────────────────┘
```

**Status:** engine, UIs, deployment, and integrations are complete and tested (184 tests). The settlement layer ships in **clearly-labeled mock mode** (`ADAPTER_MODE=mock`) — no real Bitcoin moves — because three Tachi devnet questions still block the live adapter. Mock mode is surfaced honestly everywhere (dashboard footer bar, `/healthz`), and the adapter interface is positioned as the integration spec: see **[INTEGRATION.md](INTEGRATION.md)**. Everything above the settlement boundary is real.

## Bounty #11 (Merchant Payments) — requirements

| Requirement | Where OpenTill satisfies it | Proof |
| --- | --- | --- |
| **Invoice generation** | `POST /api/invoices` → unique receive address + BIP21 URI; hosted at `/pay/:id`. | Test `happy path › create -> simulate -> paid -> confirmed`; screen `01-checkout-confirmed`. |
| **Real-time confirmation** | Poller detects payment → SSE pushes `paid`/`confirmed` live to the checkout; no refresh. | Test `SSE › streams snapshot -> paid -> confirmed`; command: pay on `/pay/:id` and watch. |
| **Dashboard w/ transactions + refunds** | `/dashboard` — overview, invoices table + detail slide-over, refund flow. | Test suite `gate3.test.ts` (stats, listing) + `dashboard-views.test.tsx`; screen `02-dashboard-overview`. |
| **Self-hosted / open-source deployment** | One MIT-licensed container; `docker compose up`, or Fly.io (`fly deploy`), or `npm run dev`. | `Dockerfile`, `docker-compose.yml`, `fly.toml`; command `docker compose up --build`. |
| **E-commerce plugin** | WooCommerce payment gateway (`plugins/opentill-for-woocommerce/`) + a from-scratch demo store. | Plugin `php -l` clean; integration test `demo store round trip`; screen `05-demo-store`. |
| **Payout & liquidity flow** | Cooperative withdrawal **and** unilateral exit (sweep to on-chain Bitcoin, no permission). | Test suite `gate4.test.ts` (both lifecycles, exit lock); screen `04-payouts-exit`. |

Screenshots live in [`docs/screenshots/`](docs/screenshots/). Demo video: **_(link to be added)_**.

## Quickstart (Docker)

```bash
cp .env.example .env     # edit the two secrets
docker compose up --build
```

Dashboard at `http://localhost:8080/dashboard`, health at `/healthz`, SQLite on a named volume. Set `OPENTILL_PORT` in `.env` to remap the host port.

**Full demo, one command** — OpenTill + the "Satoshi Beans" demo store, dev-simulate on:

```bash
docker compose -f docker-compose.demo.yml up --build
```

Open `http://localhost:4000`, buy a coffee, pay on the checkout page with the "Simulate payment (dev)" button, land back on the store's "payment confirmed" page. The store's terminal logs the signed webhook that flipped the order.

## Quickstart (no Docker)

Requires Node 20+.

```bash
npm install
cp .env.example .env          # then edit the two secrets
npm test                      # 184 tests
npm run build                 # builds checkout + dashboard into apps/web/dist
npm run dev                   # gateway on :8080
```

Checkout pages live at `http://localhost:8080/pay/<invoiceId>`, the dashboard at `http://localhost:8080/dashboard`. Demo store against it (second terminal):

```bash
OPENTILL_URL=http://localhost:8080 \
OPENTILL_API_KEY=<your key> OPENTILL_WEBHOOK_SECRET=<your secret> \
node examples/demo-store/server.mjs      # Satoshi Beans on :4000
```

(Enable the checkout's demo pay button with `OPENTILL_DEV_PUBLIC_SIMULATE=true` in `.env` — mock adapter, non-production only.)

## WooCommerce

[`plugins/opentill-for-woocommerce/`](plugins/opentill-for-woocommerce/) is a two-file plugin: install it, point it at your gateway URL + API key + webhook secret, and "Bitcoin (OpenTill)" appears as a payment method — invoice per order, hosted checkout redirect, order completion via signed webhook, "Return to store" back to order-received. `npm run build:plugin` produces the uploadable zip. Details and limitations (fixed sats-per-unit conversion) in [its README](plugins/opentill-for-woocommerce/README.md).

## Security notes

- **One API key** (`OPENTILL_API_KEY`, Bearer, constant-time compared) guards every merchant route; the dashboard keeps it in sessionStorage only. Public checkout routes carry no auth by design — the 128-bit-random invoice id is the capability; treat checkout links like password-reset links.
- **Webhooks are HMAC-SHA256 signed** (`X-OpenTill-Signature`, `OPENTILL_WEBHOOK_SECRET`) over the raw body; verify with a constant-time compare (the plugin and demo store both do).
- **Dev-simulate is triple-gated**: explicit `OPENTILL_DEV_PUBLIC_SIMULATE=true` + mock adapter + non-production, and the gateway refuses to boot when it is combined with a non-mock adapter.

## Limitations

Plainly, so there are no surprises:

- **Mock settlement.** No real Bitcoin moves. `ADAPTER_MODE=mock` simulates the Tachi settlement layer deterministically; the dashboard shows a persistent "Mock settlement mode" footer and `/healthz` reports `adapterMode: "mock"`. The real adapter is a scaffold; as of 2026-07-22 Tachi has answered co-signing (the node co-signs on broadcast, so the whole send path is spec-complete) and clarified vault creation runs against their hosted node — leaving receiver-side payment detection as the one open design question, everything else waiting on published endpoints (target 2026-08-15). Full mapping and swap-in plan in **[INTEGRATION.md](INTEGRATION.md)**; `ADAPTER_MODE=tachi` refuses to boot with a pointer to it.
- **WooCommerce sats conversion is a fixed rate.** The plugin converts order totals to sats via a merchant-set "sats per currency unit" number — no live BTC/fiat feed. Price products in sats (rate = 1) or pin a rate you manage. See the [plugin README](plugins/opentill-for-woocommerce/README.md).
- **Single-merchant auth.** One API key, one merchant, one storefront (`OPENTILL_MERCHANT_NAME`). No multi-tenant accounts — that is deliberate for a self-hosted tool.

## Deploy to Fly.io

`fly.toml` ships a single always-on machine with a persistent volume for SQLite and a `/healthz` check. Commands (fly CLI required; **not run in this repo's CI — verify against your account**):

```bash
fly launch --no-deploy            # or: fly apps create opentill   (edit app/region in fly.toml)
fly volumes create opentill_data --size 1 --region iad
fly secrets set \
  OPENTILL_API_KEY=$(openssl rand -hex 24) \
  OPENTILL_WEBHOOK_SECRET=$(openssl rand -hex 24) \
  OPENTILL_MERCHANT_NAME="Your Store"
fly deploy
fly open /dashboard               # health at /healthz
```

Secrets never live in `fly.toml` — only in `fly secrets`. The volume binds to one machine (SQLite is single-writer), so keep it to a single instance; `auto_stop_machines = false` is set for that reason.

## Layout

```
packages/
  shared/    @opentill/shared    types, zod schemas, sats/BTC helpers, constants
  adapter/   @opentill/adapter   TachiAdapter interface + MockTachiAdapter + factory
  gateway/   @opentill/gateway   Fastify server, SQLite, pollers, webhooks, SSE, static hosting
apps/
  web/       @opentill/web       Vite + React: checkout page + merchant dashboard (src/shared is common)
plugins/
  opentill-for-woocommerce/      WooCommerce payment gateway (2 PHP files, no deps)
examples/
  demo-store/                    "Satoshi Beans" — end-to-end integration example, no build step
```

Nothing outside `packages/adapter` knows which settlement implementation is in play. Swapping in the real adapter later means adding one file and a `case` in `createAdapter`.

### Frontend workflows

**Build-then-serve (what production does).** `npm run build` writes `apps/web/dist`; the gateway detects it on boot and serves it via `@fastify/static` (`/pay/:invoiceId` returns the checkout HTML, hashed assets under `/assets/*`). Rebuild after frontend changes, restart not required for the API but is for picking up a dist that didn't exist at boot. If the dist is missing, `/pay/:invoiceId` answers 503 with instructions.

**Vite dev server (frontend iteration with HMR).** Run the gateway (`npm run dev`) and, in another terminal, `npm run dev -w @opentill/web`, then open `http://localhost:5173/pay/<invoiceId>` or `http://localhost:5173/dashboard`. The Vite server proxies `/api`, `/dev`, `/pay`, and `/dashboard` to the gateway (`OPENTILL_GATEWAY_URL` env, default `http://localhost:8080`) — with one twist: `/pay/*` and `/dashboard` requests whose `Accept` includes `text/html` (i.e. browser navigations) are served the local dev pages instead of being proxied, so you get HMR while JSON and SSE requests hit the real gateway.

## Curl walkthrough

Run these against a freshly booted dev server (`ADAPTER_MODE=mock`, `NODE_ENV` unset). `jq` is optional.

```bash
export KEY=dev_api_key_change_me
export BASE=http://localhost:8080
```

**1. Health check** (no auth):

```bash
curl -s $BASE/healthz
# {"ok":true,"adapterMode":"mock","dbOk":true}
```

**2. Create an invoice for 50,000 sats:**

```bash
curl -s -X POST $BASE/api/invoices \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"amountSats":"50000","memo":"Flat white","orderId":"order-1"}'
```

```json
{
  "id": "inv_2f3c...",
  "status": "pending",
  "amountSats": "50000",
  "amountPaidSats": "0",
  "address": "mock1p...",
  "paymentUri": "bitcoin:mock1p...?amount=0.0005&label=Flat+white",
  "expiresAt": 1770000900000
}
```

Save the id and address:

```bash
export INV=inv_2f3c...
export ADDR=mock1p...
```

**3. Simulate the customer paying** (dev-only route, mock adapter only):

```bash
curl -s -X POST $BASE/dev/simulate-payment \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$ADDR\",\"amountSats\":\"50000\"}"
# {"paymentId":"mockpay_...","status":"seen",...}
```

**4. Wait for the poller** (2s tick) and read the invoice back:

```bash
sleep 3 && curl -s $BASE/api/invoices/$INV -H "Authorization: Bearer $KEY"
# status: "confirmed", amountPaidSats: "50000", payments[0].status: "committed"
```

The invoice passes through `paid` on its way there: the first poll that sees the
payment marks it `paid`, and the mock commits ~1s later, so the next poll marks
it `confirmed`. With a 2s poll interval both usually land inside 3 seconds — poll
about a second after simulating if you want to catch the intermediate `paid`
state, or watch the `previousStatus` field on the webhooks, which always shows
both hops.

**5. List and filter:**

```bash
curl -s "$BASE/api/invoices?status=confirmed&limit=10&offset=0" -H "Authorization: Bearer $KEY"
```

**6. Check the balance:**

```bash
curl -s $BASE/api/balance -H "Authorization: Bearer $KEY"
# {"offchainSats":"50000","onchainSats":"0"}
```

**7. Refund it** (legal only from `confirmed`):

```bash
curl -s -X POST $BASE/api/invoices/$INV/refund \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"toAddress":"mock1pcustomerrefund"}'
# {"txId":"mocktx_...","invoice":{"status":"refunded",...}}
```

Refunding anything else returns `409 invalid_state` naming the illegal transition.

## API

All `/api/*` routes require `Authorization: Bearer $OPENTILL_API_KEY`. Every body, param, and query string is zod-validated; failures return `400 validation_error` with per-field details.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | No auth. `{ ok, adapterMode, dbOk }`. |
| `POST` | `/api/invoices` | `{ amountSats, memo?, orderId?, webhookUrl?, returnUrl?, expiresInSeconds? }` → `201` with the invoice, `address`, and `paymentUri`. |
| `GET` | `/api/invoices/:id` | Invoice plus its `payments[]`. |
| `GET` | `/api/invoices` | Newest first. `?status=&q=&limit=&offset=` (limit 1–200, default 50). `q` matches `orderId` exactly or the invoice id by prefix. |
| `POST` | `/api/invoices/:id/refund` | `{ toAddress }`. Only from `confirmed`; refunds `amountPaidSats`. |
| `GET` | `/api/stats` | Aggregates in one SQL pass: counts + sat totals per status and a 24h confirmed window (by `confirmedAt`). Totals are `amountPaidSats` — money actually received, overpayments included. |
| `GET` | `/api/invoices/:id/webhook-deliveries` | Delivery attempts for the invoice: URL (query string redacted — it routinely carries tokens), status, attempts, last error, timestamps. |
| `POST` | `/api/webhook-deliveries/:id/retry` | Re-queues a **failed** (given-up) delivery for one more attempt. `409` if it is pending or already delivered. |
| `GET` | `/api/balance` | Proxies the adapter. |
| `POST` | `/api/payouts` | `{ kind, toAddress, amountSats? }` — `amountSats` required for `cooperative`, forbidden for `exit`. `409 exit_pending` while an exit runs; `400 payout_failed` (with the recorded payout) when the adapter rejects. |
| `GET` | `/api/payouts` | Newest first. `?limit=&offset=`. |
| `GET` | `/api/payouts/:id` | One payout. |
| `POST` | `/dev/simulate-payment` | Dev only: `NODE_ENV !== "production"` **and** `ADAPTER_MODE=mock`. Still requires the API key. |

Sat amounts are decimal **strings** everywhere on the wire and `TEXT` in SQLite, so nothing is truncated by JavaScript's 53-bit number range. They are `bigint` throughout the domain layer, converted only at the HTTP and SQL boundaries.

## Hosted checkout (public routes)

The routes under `/pay/*` are **unauthenticated by design**: the invoice id is the bearer capability. Ids are `inv_` + a UUIDv4's 32 hex chars (122 random bits) — unguessable, and treated like a token: don't log them, don't put them anywhere you wouldn't put a password-reset link. Unknown ids get one uniform `404 {"error":"not_found"}` from the same code path, so the routes expose no existence oracle beyond the 404 itself.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/pay/:invoiceId` | The checkout page (SPA entry). Serves HTML for any id; the page itself resolves 404s. |
| `GET` | `/pay/api/:invoiceId` | Public invoice view — strict allowlist, see below. |
| `GET` | `/pay/api/:invoiceId/events` | SSE stream of the same public view. |
| `POST` | `/dev/pay/:invoiceId` | Demo-only payment simulation. Exists only when `OPENTILL_DEV_PUBLIC_SIMULATE=true` (see below). |

### Public serialization

`toPublicInvoiceDTO` ([packages/gateway/src/serialize.ts](packages/gateway/src/serialize.ts)) is an explicit allowlist:

```
id, status, amountSats, amountPaidSats, memo, address, paymentUri,
createdAt, expiresAt, latePayment, devSimulate
```

`orderId`, `webhookUrl`, and refund details never pass through — enforced by a serializer unit test and a route test asserting the forbidden fields are absent. `latePayment` is true when any payment against the invoice arrived after expiry. `devSimulate` tells the page whether to show the demo button.

### SSE contract

`GET /pay/api/:invoiceId/events` (`Content-Type: text/event-stream`):

- On connect: an immediate `event: status` snapshot.
- On every status change **and** every `amountPaidSats` change: another `event: status` with the full public serialization (no deltas — each frame is a complete snapshot).
- Every 15s (`SSE_HEARTBEAT_MS`): `event: heartbeat` with `{"at": <unix ms>}` to keep proxies from idling the connection out.

Internally every invoice change is published on a typed in-process event bus ([packages/gateway/src/events.ts](packages/gateway/src/events.ts)) with one channel per invoice id; the webhook dispatcher and the SSE handlers are both subscribers. Emission is synchronous, so the webhook delivery row still commits in the same SQLite transaction as the state change (the Gate 1 guarantee). SSE listeners are removed on client disconnect — covered by a 50-cycle leak test.

The checkout page consumes the stream with `EventSource` and falls back to 5s polling of `/pay/api/:invoiceId` whenever the stream errors, resuming SSE when it reconnects.

### Dev simulate (`OPENTILL_DEV_PUBLIC_SIMULATE`)

`POST /dev/pay/:invoiceId` simulates exact payment of the invoice's remaining amount — it powers the checkout page's "Simulate payment (dev)" button and nothing else. Because it is unauthenticated, it is triple-gated:

1. `OPENTILL_DEV_PUBLIC_SIMULATE=true` must be set explicitly (default false).
2. The adapter must be the mock — the gateway **refuses to boot** if the flag is true with any other adapter.
3. `NODE_ENV` must not be `production` (the flag is silently ignored there).

When off, the route does not exist (404). The invoice payload's `devSimulate` field mirrors the flag so the page only shows the button when the endpoint is live.

## Invoice state machine

Legal transitions live in exactly one place — `INVOICE_TRANSITIONS` in [packages/gateway/src/domain/state-machine.ts](packages/gateway/src/domain/state-machine.ts) — and every status change routes through `transitionInvoice`, which throws a typed `InvalidTransitionError` on anything illegal.

```
pending ──► paid ──► confirmed ──► refund_pending ──► refunded
   │          ▲                          │
   ├──► underpaid (top-up can cover)     └──► confirmed  (send failed, error recorded)
   └──► expired    (terminal)
```

- **pending → paid** — a `seen` payment to the invoice address totalling `>= amountSats` arrives before expiry.
- **pending → underpaid** — the payment is short; the gap is recorded in `shortfallSats`.
- **underpaid → paid** *(Gate 3)* — a top-up credit brings cumulative `amountPaidSats` to `>= amountSats`. Still-short top-ups shrink `shortfallSats` without a transition.
- **paid → confirmed** — fires only when **every credited payment** (every non-late payment counted into `amountPaidSats`) has reached `committed`, not just the latest one. With a single covering payment this is identical to the old behavior; for multi-payment top-ups, "confirmed" means *all* of that money settled. Implemented in `maybeConfirm` ([packages/gateway/src/domain/invoices.ts](packages/gateway/src/domain/invoices.ts)). First confirmation stamps `confirmedAt` (kept through refund reverts) — this drives the dashboard's 24h revenue window.
- **pending → expired** — the expiry sweep (every 10s) finds `now > expiresAt`. Payments arriving after expiry are still recorded against the invoice and flagged `latePayment: true`, but do not change its state and are not credited to `amountPaidSats` — expired stays terminal.
- **Overpayment** transitions normally; `amountPaidSats` is tracked separately from `amountSats` and both are exposed. Refunds return `amountPaidSats`.

Known gaps and deliberate deviations live in [GAPS.md](GAPS.md).

## Poller and crash safety

The poller ([packages/gateway/src/poller.ts](packages/gateway/src/poller.ts)) ticks every 2s: it reads the cursor from `adapter_state`, calls `adapter.pollIncoming(cursor)` outside any transaction (it is network IO), then applies **everything it got back plus the new cursor inside a single SQLite transaction** — see `Poller.tick`, [packages/gateway/src/poller.ts:63-73](packages/gateway/src/poller.ts#L63-L73). Payment rows, invoice transitions, queued webhooks, and the cursor all commit together or not at all.

A crash before that commit replays the same batch on restart, which is safe because `applyIncomingPayment` is idempotent: `payments.payment_id` carries a `UNIQUE` constraint, and the only state change accepted for an already-known payment is `seen → committed`. Re-delivering an identical event mutates nothing and emits no second webhook.

The adapter cursor is an opaque monotonic event sequence. Each observable change to a payment (first sighting, then commit) is a separate event, so a consumer that has read up to cursor N still learns about later commits without rescanning history.

## Webhooks

When an invoice with a `webhookUrl` changes state, a delivery row is written **in the same transaction as the state change**, then POSTed:

```json
{
  "invoiceId": "inv_...",
  "orderId": "order-1",
  "previousStatus": "pending",
  "status": "paid",
  "amountSats": "50000",
  "amountPaidSats": "50000",
  "timestamp": 1770000000000
}
```

Header `X-OpenTill-Signature` carries `hmac-sha256(rawBody, OPENTILL_WEBHOOK_SECRET)` as hex. Verify against the **raw** body bytes; the stored body is frozen at enqueue time so retries are byte-identical.

Any non-2xx or transport error is retried by an interval sweep with backoff **5s → 30s → 2m → 10m**, then abandoned (5 attempts total). Every attempt is recorded in `webhook_deliveries` with its status code and error.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENTILL_API_KEY` | yes | — | Bearer token for all `/api/*` routes. Compared in constant time. |
| `OPENTILL_WEBHOOK_SECRET` | yes | — | HMAC-SHA256 key for `X-OpenTill-Signature`. |
| `OPENTILL_DB_PATH` | no | `./opentill.db` | SQLite file. Parent directories are created on boot. |
| `ADAPTER_MODE` | no | `mock` | `mock` or `tachi`. `tachi` constructs the real-adapter scaffold whose `init()` refuses to boot with a pointer to [INTEGRATION.md](INTEGRATION.md). |
| `OPENTILL_MERCHANT_NAME` | no | `OpenTill` | Storefront name shown to customers in the checkout header and POS. |
| `PORT` | no | `8080` | HTTP port. |
| `HOST` | no | `0.0.0.0` | Bind address. |
| `NODE_ENV` | no | — | Anything but `production` enables `/dev/*` routes (mock adapter only). |
| `OPENTILL_DEV_PUBLIC_SIMULATE` | no | `false` | Expose unauthenticated `POST /dev/pay/:invoiceId`. Mock adapter + non-production only; boot refuses otherwise. |
| `POLL_INTERVAL_MS` | no | `2000` | Settlement poll interval. |
| `EXPIRY_SWEEP_INTERVAL_MS` | no | `10000` | Invoice expiry sweep interval. |
| `WEBHOOK_SWEEP_INTERVAL_MS` | no | `5000` | Webhook retry sweep interval. |
| `SSE_HEARTBEAT_MS` | no | `15000` | Interval between SSE heartbeat events. |
| `OPENTILL_PAYOUT_WEBHOOK_URL` | no | — | Merchant-level webhook for payout status changes. Unset = no payout webhooks. |
| `OPENTILL_PORT` | no | `8080` | docker-compose only: host port mapped to the container's 8080. |
| `PAYOUT_POLL_INTERVAL_MS` | no | `2000` | Payout status sweep interval. |
| `OPENTILL_WEB_DIST` | no | `apps/web/dist` | Where the gateway looks for the built checkout bundle. |

Secrets belong in `.env` only — see `.env.example`. `.env` and `*.db` are gitignored.

## Database

SQLite via `better-sqlite3` in WAL mode, no ORM — hand-written SQL in [packages/gateway/src/db/repo.ts](packages/gateway/src/db/repo.ts). Tables: `invoices`, `payments`, `webhook_deliveries`, `adapter_state` (single row holding the poll cursor). Migrations are ordered `.sql` files in [packages/gateway/migrations/](packages/gateway/migrations/), applied once each on boot and tracked in `schema_migrations`.

## Payouts: two ways out of the vault

Funds live off-chain in a vault backed by real on-chain Bitcoin. OpenTill exposes both paths out, honestly, side by side:

- **Cooperative withdrawal** — the Tachi validator quorum co-signs the transaction. Fast (seconds to minutes), any amount up to your off-chain balance. This is the normal path. Lifecycle: `initiated → broadcasting → settled`.
- **Unilateral exit** — the merchant broadcasts the exit leaf of the vault taproot tree alone. No validator signs anything; nothing can stop it. It sweeps the **entire** off-chain balance and takes a timelock measured in blocks (~12 in the mock). Lifecycle: `initiated → waiting_timelock → settled`, with `timelockBlocksRemaining` counting down.

The exit is not an error path — it is the point of the product. A merchant on OpenTill can always turn their balance into plain on-chain Bitcoin even if every Tachi validator is offline or hostile, which is what makes holding funds off-chain tolerable in the first place. The dashboard presents it as a first-class option ("This is your escape hatch. It always works"), with an explicit confirmation step because it is all-or-nothing.

**While an exit is pending, the vault is being swept**: refunds, cooperative payouts, and further exits all fail with `409 exit_pending` and a plain-language message. A refund refused this way reverts `refund_pending → confirmed` with the error recorded, exactly like any other failed send. The whole off-chain balance is debited at initiation (those funds are committed to the exit transaction) and credited to `onchainSats` at settle.

Payout state is swept from the adapter every 2s by a dedicated poller ([packages/gateway/src/payout-poller.ts](packages/gateway/src/payout-poller.ts)) with the same discipline as the invoice poller: adapter IO outside the transaction, all row upserts + enqueued webhooks in one SQLite transaction, idempotent on replays. Status changes publish on a payout-specific event bus (separate channels from invoices).

**Payout webhooks** are merchant-level, not per-payout: set `OPENTILL_PAYOUT_WEBHOOK_URL` and every payout status change is POSTed there with the same HMAC-SHA256 signature header and the same retry/backoff machinery as invoice webhooks (rows share `webhook_deliveries`). Payload: `{ payoutId, kind, toAddress, amountSats, previousStatus, status, txId, timelockBlocksRemaining, timestamp }`.

## Merchant dashboard

`/dashboard` (built with the same bundle; hash-routed views: Overview, Invoices, New charge). Desktop-first, same receipt aesthetic as the checkout, holds up fine down to 768px.

**Auth model.** On load the dashboard asks for the merchant API key (a single password field), verifies it against `GET /api/stats`, and keeps it in **sessionStorage only** — never in URLs (they leak into history and server logs), never in localStorage (it survives the session and is readable by anything on the origin, forever), never in cookies (no server sessions to bind them to, and CSRF for free). sessionStorage dies with the tab, which is the right tradeoff for a single-merchant self-hosted tool: re-pasting a key once per browser session is cheap; a durable credential store is not worth building when the gateway already has exactly one key. Any `401` anywhere clears the key and returns to the prompt. The HTML shell itself is served unauthenticated — it is a static asset; every byte of data behind it requires the key.

**Freshness.** The dashboard polls every 5s (invoice list + stats) and pauses entirely while the tab is hidden (`visibilitychange`), resuming with an immediate fetch. No SSE here — polling is simpler and plenty for merchant screens.

**Views.**

- **Overview** — confirmed revenue (all-time + last 24h), pending count, refunded total, the adapter balance labeled *Spendable now (off-chain)* vs *On-chain (vault)*, and the last 10 invoices.
- **Invoices** — full table with status tabs, `q` search (orderId exact / id prefix), pagination, truncated ids that copy on click. Row click opens a slide-over detail panel.
- **Invoice detail** — every field, the payments list (seen/committed, late flag), webhook deliveries with per-delivery **Retry** for given-up ones, a link to the public checkout page, and the **Refund** flow: confirmation step showing the exact `amountPaidSats` to be returned → destination address → live result. The button is disabled with a written reason whenever the invoice is not `confirmed`.
- **New charge (POS)** — the merchant-holds-up-a-phone flow: big sats input with live BTC conversion, optional memo, then a full-size QR + live status on the same screen. It reuses the checkout's shared components (`apps/web/src/shared/`) and public SSE endpoints, so the customer watches the same pending → paid → confirmed progression; on `confirmed` a **New charge** button resets for the next sale.
- **Payouts** — the balance header ("spendable now" / "on-chain", plus an "exiting: N blocks remaining" line during an exit), the withdraw form with both paths as honest option cards, and the payout history with live timelock countdowns. The Overview shows a non-dismissable banner while an exit is pending.

## Checkout page

`apps/web` is a Vite + React multi-page app (checkout only in this gate; dashboard joins in Gate 3). Receipt aesthetic: white card on near-black, JetBrains Mono tabular numerals for every amount, Bitcoin orange (`#f7931a`) reserved for the primary action and the QR frame, plain CSS (no framework, no component library). Mobile-first — flawless at 360px.

States rendered live from the SSE feed: **pending** (QR of `paymentUri`, one-tap address copy, mm:ss countdown that turns red under 2 minutes), **partially paid** (received X of Y), **paid** (finalizing spinner, typically ~1s), **confirmed** (animated success check + receipt line), **underpaid** (amber warning), **expired** (with late-payment note), **refunded**, and **not found**. Bundle sizes (gzipped JS): checkout ≈ 59 KB, dashboard ≈ 66 KB — both pages share one common chunk (React + shared components), each adding only a small page-specific entry.

## Tests

```bash
npm test          # vitest, 170 tests
npm run typecheck # tsc --noEmit, strict, all packages + apps/web
```

Everything runs against `MockTachiAdapter` and a temp SQLite file, with a local HTTP sink capturing webhook deliveries. Coverage spans the state machine (every legal transition and every illegal one, exhaustively generated), the create → paid → confirmed happy path with signature verification, expiry and late payments, underpayment and overpayment, poll replay idempotency, refunds including a failed send reverting to `confirmed`, webhook backoff and exhaustion, auth, and validation. Gate 2 added: public serializer allowlist (unit + route), uniform 404s, the SSE snapshot → paid → confirmed flow over a real socket, heartbeats, a 50-cycle listener-leak test, `/dev/pay` gating in every combination, boot refusal for the simulate flag with a non-mock adapter, and a happy-dom render test of all eight checkout states. Gate 3 added: underpaid top-ups (single crossing, still-short shrinking, and the all-payments-committed confirm rule), exact stats numbers including the 24h boundary (23h59m in / 24h01m out), webhook delivery listing with redaction, retry happy path + both 409s, `q` filter semantics (exact orderId, id prefix, escaped LIKE wildcards), and render tests for every dashboard view — refund-disabled reasoning and the POS reset flow included. Gate 4 adds: both payout lifecycles driven by `advanceBlocks` (no sleeps), insufficient-balance failure without debit, the exit lock (refund → 409 → invoice reverts with recorded error; second exit and cooperative both 409), payout poller idempotency (unchanged snapshot → no row write, no duplicate webhook), payout webhooks through the shared HMAC + retry machinery, and render tests for the payouts view — option cards, the exit confirmation step, timelock countdown, and the overview banner.
