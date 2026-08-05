# OpenTill × Tachi — Integration Spec

**Audience:** the Tachi team, and whoever wires the real settlement adapter.

> **Status as of 2026-07-22.** Tachi answered our questions partially. **Q1
> (co-signing) is ANSWERED** — the node co-signs automatically on broadcast; no
> separate signing step. **Q3 (vault/validator access) is PARTIALLY ANSWERED** —
> Tachi runs hosted regtest/Signet RPC (no local validator set to obtain); their
> endpoints land via Swagger shortly. **Q2 (receiver-side detection) remains
> OPEN.** Net effect: the entire *send* path is now specification-complete and
> waiting only on published endpoints. Target integration date: **2026-08-15**.

OpenTill is a complete, self-hosted Bitcoin merchant gateway — invoicing, hosted
checkout, dashboard, POS, refunds, cooperative withdrawals, and unilateral exit —
running today against an in-memory **mock** settlement layer. Everything above
the settlement boundary is built and tested (184 tests). The only thing between
mock mode and real Bitcoin is one file: [`packages/adapter/src/tachi.ts`](packages/adapter/src/tachi.ts).

That file compiles today without the `@tachibtc/*` packages and is written as
documentation-as-code: every method contains the exact SDK calls it will make,
with **three `BLOCKED()` markers** at the points not yet wireable. As of
2026-07-22 one of the three (Q1, co-signing) is answered and now waits only on a
published endpoint; the markers stay until the endpoints exist. This document is
the map.

> **Why we shipped in mock mode.** We could not verify the `@tachibtc/*`
> packages or reach Tachi's hosted node with published endpoints in time, and
> the receiver-side detection path (Q2) is still an open design question. Rather
> than fake it, OpenTill labels mock mode everywhere (dashboard footer bar,
> `/healthz`, this doc) and positions the adapter interface as the integration
> contract. With Q1 answered the send path is now specification-complete; the
> architecture makes the remaining swap-in small — see §4.

---

## 1. What OpenTill needs from a settlement layer

Everything OpenTill needs is the [`TachiAdapter`](packages/adapter/src/types.ts)
interface — 9 methods. Nothing in the gateway, poller, webhook dispatcher, UI,
or test suite knows which implementation is behind it; swapping mock → real is a
factory `case`.

| Method | What it does | Lifecycle it serves |
| --- | --- | --- |
| `init()` | Connect to the daemon, create/derive the merchant vault. | Boot. |
| `createReceiveAddress(ref)` | Derive a fresh receive address in the vault. | **Invoice creation** — every invoice gets a unique address. |
| `watchAddress(addr)` / `unwatchAddress(addr)` | Register/unregister addresses the poller cares about. | Invoice creation / cleanup. |
| `pollIncoming(cursor)` | Return new payments to watched addresses since `cursor`, each `seen` or `committed`, plus the next cursor. | **Payment detection + confirmation.** `seen` → invoice `paid`; `committed` (all credited payments) → `confirmed`. |
| `send({ toAddress, amountSats, ref })` | Send sats out (cooperative spend). | **Refunds.** `confirmed → refund_pending → refunded`. |
| `getBalance()` | `{ offchainSats, onchainSats }`. | Dashboard balance; payout MAX. |
| `initiatePayout({ kind, toAddress, amountSats? })` | Start a `cooperative` withdrawal or a unilateral `exit`. | **Payouts.** Cooperative: quorum co-signs. Exit: broadcast the exit leaf alone, timelock in blocks. |
| `pollPayouts()` | Current status of all non-settled payouts. | Payout lifecycle: `initiated → broadcasting → settled` (cooperative) / `initiated → waiting_timelock → settled` (exit). |

The invoice state machine (`pending → paid → confirmed`, with `underpaid`,
`expired`, refund and exit branches) is driven entirely by `pollIncoming` +
`pollPayouts` return values. The adapter never has to know about invoices,
webhooks, or SQLite.

---

## 2. What the Tachi docs provide today

Honest mapping of each adapter method against the documented `@tachibtc/*`
surface (per docs.tachibtc.com, mirrored as local interfaces in `tachi.ts`).
**Fully** = documented SDK function exists; **Partial** = composable from
documented primitives but with an open question; **Blocked** = no documented
path.

| Adapter method | Coverage | Notes |
| --- | --- | --- |
| `init` | **Partial (Q3)** | `daemon-client.connect()` documented; points at Tachi-hosted regtest/Signet RPC. `createVault()` endpoint pending Swagger. |
| `createReceiveAddress` | **Partial (Q3)** | Vault creation is against Tachi's hosted node, not a local validator set; endpoint pending Swagger. |
| `watchAddress` / `unwatchAddress` | **Partial** | Implementable once we can enumerate incoming VTXOs (Q2). |
| `pollIncoming` | **Blocked (Q2)** | Docs cover *sending* VTXOs; no documented **receiver-side** detection of an incoming VTXO to an address we control. (The `seen → committed` step is no longer a blocker — Q1 answered: the node co-signs on broadcast.) |
| `send` (refund) | **Answered, pending endpoint (Q1)** | `buildVtxoPsbt → verify → sign → broadcast`; the node co-signs automatically on broadcast. Spec-complete once the broadcast endpoint is published. |
| `getBalance` | **Partial** | On-chain via daemon; off-chain = sum of committed VTXOs, which needs Q2. |
| `initiatePayout` (cooperative) | **Answered, pending endpoint (Q1)** | Same auto-co-sign-on-broadcast path as `send`. No separate signing endpoint to call. |
| `initiatePayout` (exit) | **Fully (after Q3 endpoint)** | `buildExitPsbt → sign → broadcast` needs no quorum — the sovereignty path is the *least* blocked. Only needs a vault (Q3). |
| `pollPayouts` | **Partial** | Cooperative: watch the broadcast tx. Exit: recompute timelock from `getBlockHeight()`. |

**Summary:** with Q1 answered, the entire *sending* side (payments' commit,
refunds, cooperative payouts, exit) is specification-complete and waiting only on
Tachi's published RPC endpoints. The one remaining design gap is **(Q2)
receiving** — detecting incoming VTXOs to an address we control. Vault creation
**(Q3)** is understood (hosted node, not local validator set) and also waiting on
the endpoint.

---

## 3. The three blocking questions

Each maps to exactly one `BLOCKED()` marker in `tachi.ts`.

### Q1 — Co-signing trigger mechanics (`Q1-cosign-trigger`) — ✅ ANSWERED
- **Answer (Tachi, 2026-07-22):** *"the Tachi node co-signs automatically on
  broadcast across devnet/regtest, Signet, mainnet; no separate signing
  endpoint."* There is no quorum round for us to drive — we build and sign our
  part, broadcast, and the node co-signs as part of accepting the broadcast.
- **What this unblocks:** the entire **send path** — cooperative payouts, refunds
  (`send`), and the `seen → committed` confirmation of incoming payments. All of
  it collapses to build → sign-our-part → broadcast.
- **Remaining blocker:** endpoint details only. We need the published broadcast
  RPC to call; the *mechanism* is settled. The scaffold's `BLOCKED` marker stays
  in place until that endpoint exists, but it now represents "waiting on the
  endpoint," not "waiting on the design."

### Q2 — Receiver-side incoming-VTXO detection (`Q2-receiver-detection`) — ⏳ OPEN
- **Where it blocks:** `pollIncoming` (and therefore `watchAddress`,
  `getBalance`).
- **Why it blocks:** OpenTill's whole model is "watch a per-invoice address,
  react when money lands." The docs cover creating and sending VTXOs; we found
  no documented **receiver** API — given a vault address we control, how do we
  learn a VTXO was credited to it and read its `pending`/`committed` state.
- **Unblocks:** payment detection → the entire invoice lifecycle, balance.
- **Three answer shapes we proposed (any one works), best-first:**
  1. **Subscribe / stream** — a push feed (websocket / gRPC stream) of VTXOs by
     watched address. Lets us drop polling and emit to checkout even faster.
  2. **Pollable query** — a `listVtxos({ address, sinceCursor })`-style call
     (including a raw ABCI query we issue ourselves) that maps directly onto our
     existing cursor-based poller.
  3. **Scan committed VTXOs by output address** — if we can enumerate committed
     VTXOs and filter by output address, we can reconstruct credits ourselves.

### Q3 — Vault creation / validator access (`Q3-validator-access`) — 🟡 PARTIALLY ANSWERED
- **Answer (Tachi, 2026-07-22):** there is **no local validator set** to obtain;
  Tachi provides **hosted regtest/Signet RPC** and vaults are created against
  that node. A **local regtest `bitcoind` per the tutorial will NOT work** against
  their node — it's a private network. Concrete endpoints arrive via **Swagger
  shortly**.
- **Where it blocks:** `createReceiveAddress` (via `createVault`) and `init`.
- **Remaining blocker:** the published vault-creation endpoint. The model is now
  clear (talk to Tachi's hosted node, not a local chain), so this is an endpoint
  wiring task, not an unknown.
- **Implication for testing:** our "run against regtest" plan targets **Tachi's
  hosted regtest RPC**, not a local `bitcoind`.

---

## 4. Swap-in plan (questions answered → real settlement live)

The architecture is designed so this is **days, not weeks**:

1. **Install the SDK** (once the packages + token are confirmed):
   `npm i @tachibtc/daemon-client @tachibtc/vault-core -w @opentill/adapter`.
   Replace the local mirror interfaces in `tachi.ts` with the real imports (the
   signatures already match the documented surface).
2. **Point config at Tachi's hosted node:** flip `ADAPTER_MODE=tachi` and add the
   hosted regtest/Signet RPC connection settings (URL / token) — **not** a local
   `bitcoind`. `init()` stops throwing once the vault-creation endpoint is wired.
3. **Fill the sections in `tachi.ts`** — each is already a commented walkthrough:
   - **Q1 (answered)** → `send` + `initiatePayout` cooperative: build → sign our
     part → broadcast; the node co-signs on broadcast. Just wire the published
     broadcast endpoint — no quorum protocol to implement.
   - **Q3 (endpoint pending)** → `createReceiveAddress`/`init`: call the hosted
     node's `createVault` / address-derivation endpoint (from Swagger).
   - **Q2 (open)** → `pollIncoming`: whichever of the three answer shapes Tachi
     ships (subscribe, pollable query, or scan-by-output-address), map VTXO state
     → seen/committed. The `exit` payout and `getBalance`/`watchAddress` follow.
4. **Run the existing suite against Tachi's hosted regtest.** The gateway e2e
   tests (`packages/gateway/test/*`) are adapter-agnostic — they drive the invoice
   and payout lifecycles through the `TachiAdapter` interface. The mock's
   deterministic `advanceBlocks()` maps to regtest block generation on the hosted
   node.

**Estimate:** the *send* path (Q1) is now specification-complete — with endpoints
published it is wiring, not design. Remaining real work is **Q2** (detection, the
one load-bearing unknown) plus endpoint plumbing for Q3. Once Tachi publishes the
Swagger endpoints and answers Q2, ~2–3 days: roughly a day on Q2 detection, half
a day each on vault bootstrap (Q3) and the send/exit endpoints, the rest
validating against the existing suite. Target: **2026-08-15**. The small size is
the whole point of the adapter boundary — the product doesn't change, only this
one file gets wired up.
