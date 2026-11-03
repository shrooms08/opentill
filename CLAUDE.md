# CLAUDE.md — OpenTill

Onboarding notes for future Claude Code sessions. Written 2026-11-03 from a full read of the repo at `30a0465` (branch `main`, clean tree). The deep docs are [README.md](README.md), [INTEGRATION.md](INTEGRATION.md) (Tachi ground truth) and [GAPS.md](GAPS.md). This file is the map; those are the territory.

**Never print secret values** (`.env`, `TACHI_MNEMONIC`, `.tachi-*-state.json`, Fly secrets). Refer to variables by name.

---

## 1. Project summary

OpenTill is a self-hosted Bitcoin payment gateway: one Node process/container that issues invoices, shows customers a hosted checkout page (QR + live status), and gives the merchant a dashboard with refunds, a point-of-sale screen and payouts.
Settlement runs on the **Tachi network** (an off-chain ledger of VTXOs backed by on-chain Bitcoin), behind a pluggable adapter: `mock` (in-memory) or `tachi` (real, proven on Tachi regtest).
It ships a WooCommerce plugin and a tiny demo store; anything else integrates through a Bearer-auth JSON API and HMAC-signed webhooks.
It was built as a submission for a "Bounty #11 (Merchant Payments)" — the README maps each requirement to code/tests.
Receiving, confirmation and refunds are real on regtest; **payouts to L1 are mock-only** because Tachi has no ledger→L1 path for receipts yet.

## 2. Architecture

```
  customer browser            merchant browser             merchant backend / WooCommerce
        │ /pay/:id (HTML)            │ /dashboard (HTML)          │ /api/* (Bearer OPENTILL_API_KEY)
        │ /pay/api/:id  + SSE        │ /api/* (key in             │
        │ /dev/pay/:id (mock demo)   │  sessionStorage)           │       ▲ HMAC-signed webhooks
        ▼                            ▼                            ▼       │ (X-OpenTill-Signature)
 ┌──────────────────────────── packages/gateway (Fastify 5, one process) ──────────────────────┐
 │ routes.ts (auth API) · public-routes.ts (checkout/SSE) · @fastify/static → apps/web/dist     │
 │ domain/state-machine.ts ── domain/invoices.ts ── domain/payouts.ts                           │
 │ events.ts (sync in-process bus) ──► webhooks.ts (enqueue in same txn, retry sweep)           │
 │ poller.ts (2s) · payout-poller.ts (2s) · expiry sweep (10s)                                  │
 │ db/ (better-sqlite3, WAL, hand-written SQL, migrations/*.sql)                                │
 └───────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                 │ TachiAdapter interface (packages/adapter/src/types.ts)
                 ┌───────────────┴────────────────┐
         MockTachiAdapter (mock.ts)        TachiRealAdapter (tachi.ts)
         in-memory, no network             @tachibtc/tachi-sdk-ts + taurus-vault-core
                                           BIP-39 mnemonic → BIP-84 keys, JSON key index
                                                   │ HTTPS JSON-RPC
                                                   ▼
                                  Tachi daemon (default https://rpc-regtest.tachibtc.com,
                                  chain tachi-regtest-1) + its Bitcoin RPC proxy (scantxoutset)
```

- **Gateway** ([packages/gateway/src](packages/gateway/src)): `main.ts` → `loadConfig()` → `createApp()` ([app.ts](packages/gateway/src/app.ts)) wires adapter → DB → services → HTTP. `adapter.init()` runs **before** `listen()` (in tachi mode that's a network call; boot fails if the daemon is unreachable or on the wrong chain).
- **Pollers**: adapter IO happens outside a transaction; results + cursor are applied in **one SQLite transaction** ([poller.ts:54-77](packages/gateway/src/poller.ts#L54-L77)). `applyIncomingPayment` is idempotent on `(paymentId, status)`.
- **Event bus** ([events.ts](packages/gateway/src/events.ts)) is synchronous so webhook rows commit in the same transaction as the state change. SSE handlers and the webhook dispatcher both subscribe.
- **Frontend** ([apps/web](apps/web)): Vite multi-page app (`checkout.html`, `dashboard.html`), React 18, plain CSS, no component library. The built `apps/web/dist` is served by the gateway; without it `/pay/:id` and `/dashboard` return 503.
- **WooCommerce plugin** ([plugins/opentill-for-woocommerce](plugins/opentill-for-woocommerce)): PHP, server-to-server `POST /api/invoices`, redirect to `/pay/:id`, order state driven by signed webhooks. Classic + Blocks checkout.
- **Demo store** ([examples/demo-store/server.mjs](examples/demo-store/server.mjs)): "Satoshi Beans", plain `node:http`, in-memory orders, verifies webhooks.

## 3. Tech stack and versions (installed)

| Area | Tech |
| --- | --- |
| Runtime | Node ≥ 20 (mock), **≥ 22 for tachi mode** (SDK engines). Docker uses `node:22-bookworm(-slim)`. Local machine had v24. |
| Language | TypeScript 5.9 (strict, `noUncheckedIndexedAccess`), ESM, run directly with **tsx 4.23** (no compile step, even in prod) |
| Server | Fastify 5.10, @fastify/static 8.3, zod 3.25 |
| DB | SQLite via better-sqlite3 11.10 (WAL), no ORM |
| Bitcoin/Tachi | @tachibtc/tachi-sdk-ts 0.2.1, @tachibtc/taurus-vault-core 0.3.3, bitcoinjs-lib 7.0.1, bip32 5, bip39 3, @bitcoinerlab/secp256k1 |
| Web | React 18.3, Vite 6.4, qrcode, @fontsource (Space Grotesk, JetBrains Mono) |
| Tests | Vitest 4.1 (`pool: forks`), happy-dom + Testing Library for UI |
| Plugin | PHP (WordPress/WooCommerce), one build-free JS file |
| Monorepo | npm workspaces: `packages/*`, `apps/*` |

## 4. Directory map

```
packages/shared/     @opentill/shared — types, zod schemas, sats helpers, constants (no deps but zod)
packages/adapter/    @opentill/adapter — TachiAdapter interface, mock.ts, tachi.ts (+ tachi/{client,keys,state,tx}.ts), factory.ts
packages/gateway/    @opentill/gateway — Fastify server, domain logic, pollers, webhooks, SSE, db/, migrations/
  test/              gateway tests (gate3/4/5 = feature gates; helpers.ts = test app + webhook sink)
apps/web/            @opentill/web — checkout + dashboard (src/checkout, src/dashboard, src/shared), test/
plugins/opentill-for-woocommerce/   WooCommerce gateway plugin
examples/demo-store/ Satoshi Beans demo store
scripts/             tachi-*.ts (smoke, e2e, fund, pay, vault/lock spikes — all hit the real regtest daemon),
                     build-plugin-zip.sh, generate-favicons.mjs
docs/                tachi-*-output.md / *-spike.md (verbatim daemon transcripts), brand/, screenshots/
design/              *.dc.html design comps (Checkout v2, Dashboard v2, Tokens v2) — reference only
Dockerfile, docker-compose.yml, docker-compose.demo.yml, fly.toml (opentill-demo), fly.live.toml (opentill-live)
```

Local-only, gitignored files you'll see in the root: `.env`, `.tachi-smoke-state.json` (holds the regtest **customer** mnemonic used by `pay:tachi`), `.tachi-spike-state.json`, `.tachi-lock-state.json`, `packages/gateway/opentill.db*`. Treat all of them as secret.

## 5. How to run locally

```bash
npm install
cp .env.example .env            # then set the two secrets (openssl rand -hex 24)
npm run typecheck               # tsc --noEmit, both tsconfigs
npm test                        # vitest, 197 tests, no network
npm run build                   # writes apps/web/dist (needed for /pay and /dashboard)
npm run dev                     # gateway on :8080 (tsx watch, loads ../../.env if present)
# open http://localhost:8080/dashboard  (paste OPENTILL_API_KEY)
```

Frontend with HMR: `npm run dev` + `npm run dev:web` → `http://localhost:5173/dashboard` (Vite proxies to `OPENTILL_GATEWAY_URL`, default `:8080`).

Mock demo with a "Simulate payment" button: set `OPENTILL_DEV_PUBLIC_SIMULATE=true`, `ADAPTER_MODE=mock`, `NODE_ENV` unset.

Full demo in Docker: `docker compose -f docker-compose.demo.yml up --build` → store `:4000`, dashboard `:8080/dashboard` (keys default to `demo_api_key` / `demo_webhook_secret`).

Demo store against a local gateway: `OPENTILL_URL=http://localhost:8080 OPENTILL_API_KEY=… OPENTILL_WEBHOOK_SECRET=… node examples/demo-store/server.mjs`.

Real (tachi) mode: set `ADAPTER_MODE=tachi`, `TACHI_MNEMONIC` (fresh, throwaway), `TACHI_NETWORK=regtest`; `npm run dev`; fund the till address from the boot log with `TACHI_MNEMONIC=… npm run fund:tachi -- --sats 50000`; pay an invoice with `npm run pay:tachi -- <bcrt1p…> <sats>` (uses the customer key in `.tachi-smoke-state.json`). Other network scripts: `smoke:tachi`, `e2e:tachi`, `spike:vault`, `spike:lock`.

Plugin zip: `npm run build:plugin` → `dist/opentill-for-woocommerce.zip`.

## 6. Environment variables

Read in [packages/gateway/src/config.ts](packages/gateway/src/config.ts) unless noted. "Example" = present in `.env.example` (✓ active, # commented out).

| Variable | Used by | Default | Example |
| --- | --- | --- | --- |
| `OPENTILL_API_KEY` (required) | gateway auth; demo store | — | ✓ (placeholder) |
| `OPENTILL_WEBHOOK_SECRET` (required) | webhook HMAC; demo store | — | ✓ (placeholder) |
| `OPENTILL_DB_PATH` | SQLite file | `./opentill.db` (relative to cwd → `packages/gateway/` under `npm run dev`) | ✓ |
| `ADAPTER_MODE` | `mock` \| `tachi` | `mock` | ✓ |
| `TACHI_MNEMONIC` | tachi mode (required there); `scripts/tachi-fund.ts` | — | # |
| `TACHI_NETWORK` | `regtest` \| `signet` | `regtest` | # |
| `TACHI_RPC_URL` | gateway + every `scripts/tachi-*.ts` | `https://rpc-regtest.tachibtc.com` | # |
| `TACHI_API_KEY` | optional daemon `X-Api-Key` | — | # |
| `TACHI_STATE_PATH` | key index JSON | `<dir of DB>/tachi-adapter.json` | # |
| `OPENTILL_MERCHANT_NAME` | checkout header / POS | `OpenTill` | ✓ |
| `PORT` | gateway; demo store | `8080` (store: `4000`) | ✓ |
| `HOST` | gateway; demo store | `0.0.0.0` | ✗ (set in Dockerfile/fly) |
| `NODE_ENV` | `production` disables `/dev/*` | unset | ✗ (Dockerfile sets `production`) |
| `OPENTILL_DEV_PUBLIC_SIMULATE` | unauth `/dev/pay/:id`; boot refuses with non-mock | `false` | ✓ |
| `OPENTILL_PAYOUT_WEBHOOK_URL` | payout webhooks | unset = off | # |
| `POLL_INTERVAL_MS` / `EXPIRY_SWEEP_INTERVAL_MS` / `WEBHOOK_SWEEP_INTERVAL_MS` / `SSE_HEARTBEAT_MS` / `PAYOUT_POLL_INTERVAL_MS` | timers | 2000 / 10000 / 5000 / 15000 / 2000 | # |
| `OPENTILL_WEB_DIST` | built UI dir | `apps/web/dist` | # |
| `OPENTILL_PORT` | docker-compose host port only | `8080` | # |
| `OPENTILL_GATEWAY_URL` | [apps/web/vite.config.ts](apps/web/vite.config.ts) dev proxy | `http://localhost:8080` | ✗ |
| `OPENTILL_URL`, `OPENTILL_PUBLIC_URL`, `DEMO_BASE_URL`, `DEMO_PUBLIC_BASE_URL` | demo store only | see compose file | ✗ |
| `TACHI_SMOKE_MNEMONIC`, `TACHI_FAUCET_URL` | `scripts/tachi-smoke.ts` | — | ✗ |
| `SPIKE_CSV`, `SPIKE_STATE` | `scripts/tachi-{vault,lock}-spike.ts` | — | ✗ |

## 7. External integrations — status

| Integration | Status | Evidence |
| --- | --- | --- |
| Tachi: per-invoice receive addresses | **REAL** (regtest) | [tachi.ts:132-141](packages/adapter/src/tachi.ts#L132-L141), [tachi/keys.ts](packages/adapter/src/tachi/keys.ts) |
| Tachi: payment detection (`seen`/`committed`) | **REAL**, polling only (WS `watch()` not wired) | [tachi.ts:165-206](packages/adapter/src/tachi.ts#L165-L206); txids in INTEGRATION.md §4 |
| Tachi: refunds (ledger TRANSFER, `code===0` + commit) | **REAL** | [tachi.ts:210-265](packages/adapter/src/tachi.ts#L210-L265), [tachi/tx.ts](packages/adapter/src/tachi/tx.ts) |
| Tachi: balances | **REAL** (off-chain Σ per key; on-chain via `scantxoutset` proxy, cached 60s) | [tachi.ts:269-300](packages/adapter/src/tachi.ts#L269-L300) |
| Tachi: payouts (cooperative / unilateral exit) | **STUBBED** — always returns a `failed` payout; `pollPayouts` → `[]` | [tachi.ts:304-322](packages/adapter/src/tachi.ts#L304-L322) |
| Payouts / exit UX | **MOCKED** (full lifecycle, 12 mock blocks × 2s) | [mock.ts](packages/adapter/src/mock.ts) |
| Bitcoin L1 vault exit / cooperative refund | **Proven in a spike script only**, not in product; moves self-deposited L1 funds, not receipts | [scripts/tachi-vault-spike.ts](scripts/tachi-vault-spike.ts), [docs/tachi-vault-spike.md](docs/tachi-vault-spike.md) |
| `TxLockForVault` (receipt → vault) | **HALF-BUILT spike, abandoned** — every shape rejected `code 12`; Tachi says it has no L1 effect anyway | [scripts/tachi-lock-spike.ts](scripts/tachi-lock-spike.ts), INTEGRATION.md §5.3d–5.4 |
| Ledger funding (`TxDeposit`) | **REAL on regtest/signet only** (self-signed; mainnet needs attestation — not implemented) | [scripts/tachi-fund.ts](scripts/tachi-fund.ts), GAPS.md |
| BIP21 payment URI / QR | **PLACEHOLDER** — `bitcoin:<addr>?amount=` "placeholder for Gate 1"; no Tachi URI scheme | [packages/shared/src/sats.ts:21-28](packages/shared/src/sats.ts#L21-L28) |
| Signet / mainnet | Signet untested (should work); mainnet unsupported | GAPS.md |
| WooCommerce plugin | **Built, lint-only** (no WP test harness) | [plugins/…/class-wc-gateway-opentill.php](plugins/opentill-for-woocommerce/includes/class-wc-gateway-opentill.php) |
| Webhooks (HMAC-SHA256, retries 5s→30s→2m→10m, 5 attempts) | **REAL**, tested | [webhooks.ts](packages/gateway/src/webhooks.ts), `test/webhooks.test.ts` |
| BTC/fiat price feed | **None** (plugin uses a fixed sats-per-unit rate) | plugin README |

## 8. Deployment

**Primary host: Railway** (since 2026-11-04; Fly is billing-locked). Runbook: [RAILWAY.md](RAILWAY.md).
- [railway.json](railway.json): Dockerfile builder, `/healthz` check (120s), restart ON_FAILURE, 1 replica.
- Services `opentill-live` (tachi, regtest) and `opentill-demo` (mock + simulate button), each with a volume at `/data`.
- Variables: templates `.env.railway-{live,demo}.example` (committed); filled `.env.railway-{live,demo}` (gitignored). Load them with `sh scripts/railway-load-env.sh <file> <service>`, which pipes each value through `railway variable set KEY --stdin`, so values are never shown.
- [docker/entrypoint.sh](docker/entrypoint.sh): started as root (`RAILWAY_RUN_UID=0`) → `chown` the data dirs, `gosu node`. Started non-root → writability check with a clear error.
- `OPENTILL_PUBLIC_URL` → `https://$RAILWAY_PUBLIC_DOMAIN` → null; builds `checkoutUrl` on merchant invoice DTOs ([config.ts](packages/gateway/src/config.ts) `resolvePublicUrl`).
- Railway live uses a **new** mnemonic. The real adapter refuses to boot when a used mnemonic meets an empty state file ([tachi.ts](packages/adapter/src/tachi.ts) init guard). The old Fly volume backup lives at `../opentill-backup/opentill-live-data.tgz`.

**Legacy (Fly.io, kept for reference):**
- `Dockerfile`: 2-stage, `npm ci` → `npm run build` → `npm prune --omit=dev`; runtime runs **as user `node`**, `NODE_ENV=production`, `OPENTILL_DB_PATH=/data/opentill.db`, `CMD tsx packages/gateway/src/main.ts`, Docker HEALTHCHECK on `/healthz`.
- `docker-compose.yml` (prod-ish, named volume) and `docker-compose.demo.yml` (gateway + demo store, simulate on).
- Fly.io, region `jnb`, single always-on machine + volume each:
  - `fly.toml` → **opentill-demo** (mock). The dev-simulate route is live there (probe 2026-11-03), so `NODE_ENV` and `OPENTILL_DEV_PUBLIC_SIMULATE=true` must be set as Fly secrets; they are **not** in `fly.toml`.
  - `fly.live.toml` → **opentill-live** (tachi, regtest). Secrets `OPENTILL_API_KEY`, `OPENTILL_WEBHOOK_SECRET`, `TACHI_MNEMONIC` are in Fly secrets only. Key index at `/data/tachi-state.json`.
  - Both returned `{"ok":true,…,"dbOk":true}` on `/healthz` on 2026-11-03.
- No CI config (`.github/` absent).

**Railway: nothing exists** (no `railway.json`/`railway.toml`, `Procfile`, or nixpacks config). What it would take:
1. Railway auto-detects the Dockerfile, so a config file is optional. Add `railway.json` if you want `healthcheckPath: /healthz` and a pinned single replica in code.
2. Attach a **volume at `/data`** (SQLite and the tachi key index live there). Keep it to **1 replica** (SQLite single-writer; the key index is a local file).
3. **Volume permissions:** the image runs as `node`, but Railway volumes mount root-owned, so SQLite will likely fail to open with EACCES. Railway's documented fix is the `RAILWAY_RUN_UID=0` variable (or change the image). Verify on first deploy.
4. Variables: `OPENTILL_API_KEY`, `OPENTILL_WEBHOOK_SECRET`, `ADAPTER_MODE`, `OPENTILL_MERCHANT_NAME`. Tachi mode also needs `TACHI_MNEMONIC` (a **new** one per instance — never reuse opentill-live's), `TACHI_NETWORK=regtest`, `TACHI_STATE_PATH=/data/tachi-state.json`. `PORT` is injected by Railway and read by the app, and `HOST=0.0.0.0` is already set in the image.
5. Mock demo with the pay button: override `NODE_ENV` (e.g. `development`) **and** set `OPENTILL_DEV_PUBLIC_SIMULATE=true`, because the image bakes `NODE_ENV=production`.
6. Tachi mode: fund the new till with `npm run fund:tachi` after first boot (the till address is in the boot log). Boot needs the Tachi RPC reachable before it listens, so allow a generous healthcheck timeout.
7. Update the README "Try it" links, which point at `*.fly.dev`.

## 9. Known issues and gaps

Most deliberate gaps are already listed in [GAPS.md](GAPS.md). Additional findings from this read:

- **Leaked-key cleanup (2026-11-03, commit "security: rotate leaked API key…").** The README used to publish the opentill-live API key (in history since `30a0465`). `.env.example` used to carry the local dev key (in history since `8e7346f`). Both are scrubbed, but history was **not** rewritten: the old values are harmless only once rotated on Fly. `packages/gateway/tachi-state.json` (runtime key index) is untracked and ignored. **Never publish a merchant API key**; it can issue refunds and drain the till float.
- **API key is env-only.** `OPENTILL_API_KEY` is read in `config.ts` and constant-time compared in `routes.ts`; nothing is stored in SQLite. Rotating = change the env/secret and restart.
- **Watched addresses are never removed.** The gateway never calls `unwatchAddress`. In tachi mode every tick makes 2 sequential RPCs per invoice ever created, plus `getStatus`. Latency grows with history, and overlapping ticks are skipped via `#inFlight`.
- **Refund change can be re-credited to another invoice (likely bug, untested).** `send()` picks the *smallest* single key that covers `amount+fee`, so it can spend an invoice key rather than the till ([tachi.ts:226](packages/adapter/src/tachi.ts#L226)). The change returns to that key, which is still watched. The next poll records it as a new committed payment and credits it to that invoice as an overpayment.
- **Stale payout error text.** `initiatePayout` says "TxLockForVault has no SDK builder yet". INTEGRATION.md §5.4 now says the blocker is a protocol gap. The §3 table in INTEGRATION.md has the same stale wording.
- **Real-mode QR uses a `bitcoin:` URI** for an address that only receives on the Tachi *ledger*. An ordinary Bitcoin wallet would pay L1 and the gateway would never detect it. Real payments currently come only from `npm run pay:tachi` or another Tachi ledger wallet.
- **Payouts view has no real-mode awareness.** It shows both payout cards in tachi mode, and submitting creates a `failed` payout row (400 `payout_failed`).
- **Mock adapter state is in-memory.** After a restart, balances, payouts and the event log reset while SQLite invoices persist, so a restarted mock demo shows revenue but 0 spendable.
- **Doc drift.** Test count is 197 (README says 195 and, in "Tests", 170). The main README calls the plugin "two-file"; the plugin README says three PHP + one JS. The README "Checkout page" section still says "checkout only in this gate". The demo video link is "_(link to be added)_".
- **Production runs TypeScript through tsx** (no precompile). It's documented, but means a slower cold start and `tsx` as a runtime dependency.
- **No TODO/FIXME markers** anywhere in the source. No CI.
- **Plugin has no automated tests** (lint-only by design).
- **Hardcoded values:** default RPC `https://rpc-regtest.tachibtc.com`; `pay:tachi`/`fund:tachi` hardcode `regtest`; mock exit = 12 blocks × 2s; fee = daemon minimum (1 sat); commit wait 90s; L1 balance cache 60s; QR colors as literals in `Qr.tsx`.

## 10. Conventions

- **Sats are `bigint` in the domain, decimal strings on the wire, `TEXT` in SQLite.** Never use `number` for amounts. Convert only at HTTP/SQL boundaries (`serialize.ts`, `repo.ts`).
- **Invoice status changes only via `transitionInvoice`** ([domain/invoices.ts](packages/gateway/src/domain/invoices.ts)), validated against `INVOICE_TRANSITIONS` ([state-machine.ts](packages/gateway/src/domain/state-machine.ts)), the single source of truth.
- **Network IO outside transactions, all DB effects of one batch inside one transaction.** Webhook rows are enqueued synchronously inside the state-change transaction.
- **Nothing outside `packages/adapter` may know which adapter is active** (except `instanceof MockTachiAdapter` gating `/dev/*`). Add adapters via `createAdapter` in [factory.ts](packages/adapter/src/factory.ts).
- **Tachi "a resolved promise is not success":** check `result.code === 0` **and** wait for commit. Broadcast verdicts are truth; `/tachi_txValidate` is not.
- **Public serialization is an explicit allowlist** (`toPublicInvoiceDTO`). Never leak `orderId`, `webhookUrl` or refund details to `/pay/*`. Unknown ids get a uniform 404.
- **Validation:** zod schemas in `@opentill/shared`, `parseOr400` in routes, errors as `{ error: snake_case_code, message, … }`.
- **Ids:** `inv_`/`pay_`/`po_`/`whd_` + UUIDv4 hex.
- **Code style:** ESM, `#private` class fields, injectable deps for tests (`TachiRealAdapterDeps`), comments explaining *why*, no ORM, no CSS framework. CSS tokens in `apps/web/src/shared/tokens.css`.
- **Tests:** never touch the network (`npm test` is mock-only). Real-daemon checks live in `scripts/` and write transcripts to `docs/`. Drive time explicitly (`poller.tick()`, `advanceBlocks`) rather than sleeping.
- **Honesty in docs/UI:** mock mode is labeled in the dashboard, and unimplemented real-mode features fail loudly instead of faking success. Keep that standard.
- **Commits:** conventional-ish prefixes (`fix:`, `docs:`, `spike:`, `brand:`).
- **Tachi secrets:** one throwaway mnemonic per instance, stored only as a host secret. Key state lives on the persistent volume.
