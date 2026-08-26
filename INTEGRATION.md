# OpenTill × Tachi — how the integration works

**Status as of 2026-08-25: real settlement is live on Tachi regtest** for the
whole merchant-facing receive path — per-invoice addresses, payment detection,
`seen → committed` confirmation, and refunds — proven end to end against
`https://rpc-regtest.tachibtc.com` with real transaction ids (below). The
mock adapter remains the test/demo/CI adapter; `ADAPTER_MODE=tachi` selects
the real one behind the same `TachiAdapter` interface.

What is **not** implemented in real mode: **payouts to L1** — cooperative
withdrawal and unilateral exit. §5 says exactly why and what it would take.

Ground truth for every claim here: [`docs/tachi-smoke-output.md`](docs/tachi-smoke-output.md)
(verbatim daemon responses) and [`docs/tachi-e2e-output.md`](docs/tachi-e2e-output.md)
(the full round trip through the gateway).

---

## 1. The ledger model OpenTill builds on (verified)

- A Tachi ledger **VTXO** is `{ id, owner, amount, spent, height, script, locked }`.
  `owner` is a **32-byte x-only secp256k1 key**. Ownership is keyed on the key,
  not on an L1 output — receiving involves nothing on L1.
- A **receive address** is that x-only key encoded as a bech32m P2TR output key
  (`bcrt1p…` / `tb1p…` / `bc1p…`); the daemon and `xOnlyFromAddress` decode it
  straight back. `getAddressVtxos(address | pubkeyHex)` returns the owner's VTXOs.
- A **transfer** between two keys is a `TachiTx` of type `TRANSFER` with
  `inputs: [{ vtxoId, txid: 0x00…, vout: 0, valueSats }]`, `outputs:
  [{ owner, amount }]`, `fee`, `nonce`, `pubKey`, a BIP-340 signature over the
  TachiTx sighash, and an **empty PSBT payload** — no vault, no PSBT, no quorum
  round. The node co-signs on broadcast (Tachi-confirmed; observed).
- `vtxoId = SHA256(txHash ‖ be32(vout))` (`computeVtxoId`) for deposits **and**
  transfers — so a *pending* tx already yields the exact VTXO id that later
  commits. That is what makes `seen → committed` a stable identity.
- Transaction alerts arrive twice on `/tachi_ws` (`state: "pending"` on CheckTx,
  `state: "committed"` on block commit), for the **receiver's** address filter
  too. Blocks commit every few seconds on regtest.
- **A resolved promise is not success.** `broadcastTxSync` returns HTTP 200
  with the verdict inside: `result.code` (0 = mempool accepted), `result.log`.
  Mempool acceptance is not a commit; `waitForTachiTxCommit` (or `/tachi_tx`)
  is the confirmation. OpenTill treats a send as done only on `code === 0`
  **and** `committed === true`.

## 2. Key management

One BIP-39 mnemonic (`TACHI_MNEMONIC`) derives every merchant key along BIP-84
paths using the SDK's own `deriveUserKey` (so Tachi tooling reproduces the same
descriptors):

| Key | Path (regtest) | Role |
| --- | --- | --- |
| till | `m/84'/1'/0'/0/0` (receive chain, index 0) | the merchant float — refunds are paid from whichever key covers `amount + fee`; fund this one |
| invoice *n* | `m/84'/1'/0'/1/n` (change chain) | one fresh key per invoice; the customer pays to its P2TR address |

The adapter keeps a small JSON index (`TACHI_STATE_PATH`, default next to the
SQLite file): handed-out keys, the next invoice index, and the watched-address
set — re-derivable from the mnemonic, written atomically, and what lets a
restarted gateway keep detecting payments to open invoices.

**Cost model:** a key is free (pure derivation) — no vault, no L1 tx per
invoice. That is why OpenTill does *not* create a Taurus vault per invoice.

## 3. `TachiAdapter` → daemon calls

| Method | Real implementation | Proven by |
| --- | --- | --- |
| `init()` | `getHealth` + `getStatus`; refuses to boot if the daemon's chain id doesn't match `TACHI_NETWORK`; logs chain id + height + till address | e2e boot; unit test |
| `createReceiveAddress` | next change-chain key → P2TR address, persisted | e2e invoice `inv_d5884327…` |
| `watchAddress` / `unwatchAddress` | persisted watched set | e2e |
| `pollIncoming(cursor)` | per watched address: `getMempoolByAddress` → **seen** (paymentId = `computeVtxoId(tx_hash, vout)`), `getAddressVtxos(addr, includeSpent)` → **committed** for VTXOs above the height cursor. Cursor = daemon height at tick start − 1, so a block landing mid-tick is never skipped; the gateway is idempotent on `(paymentId, status)` | e2e: invoice `pending → confirmed` via real ticks (the block landed before the first tick, so the gateway saw the payment straight as `committed`; the `seen` mapping is unit-tested and the underlying `pending`→`committed` alert pair was observed live via `watch` in the smoke) |
| `send` (refund) | pick one key covering `amount + fee` (one TachiTx = one signer), largest-first inputs, change back, `getAccountNonce`, sign, `broadcastTxSync` → assert `code === 0` → `waitForTachiTxCommit` → assert committed; returns the tx hash | e2e refund `698e3128…bf71` |
| `getBalance` | off-chain = Σ `getBalance(key)`; on-chain = `scantxoutset` over our `addr()` descriptors through the daemon's Bitcoin RPC proxy (cached) | e2e: 39 998 off-chain / 200 000 on-chain |
| `initiatePayout` | **not implemented** — returns a `failed` payout with the reason (§5) | unit test |
| `pollPayouts` | `[]` | — |

Polling is the correctness path (crash-safe by construction). `watch()` was
verified in the smoke as a future low-latency supplement but is not wired in.

## 4. What ran for real (ids)

Smoke (`npm run smoke:tachi`, regtest):

- daemon `tachi-regtest-1`, height 482 085 at connect, 7 validators
- faucet → L1: `46644a82…57db`, `dfc5c71b…6eb9` (0.001 BTC each to our taproot
  address; confirmed at L1 height 9438)
- self-signed ledger deposit **rejected** with `code 8: fee below minimum` at
  fee 0, **committed** at fee 1: tx `24fef4e7…fbed` → VTXO `04411f3a…8200`
  (50 000 sats, height 482 189)
- plain key→key transfer, no vault/PSBT: tx `c930934b…a789`, height 482 190
  (10 000 to key1, 39 999 change); `pending` + `committed` alerts received on
  **both** sender and receiver `watch({ address })` filters

Public live instance (`https://opentill-live.fly.dev`, `ADAPTER_MODE=tachi`, deployed 2026-08-26):

- boot: `tachi: connected {chainId: "tachi-regtest-1", height: 497237, tillAddress: "bcrt1psgqq…ung6", statePath: "/data/tachi-state.json"}`
- till funded by ledger deposit `af05fd1d…caf6` (50 000 sats)
- invoice `inv_8f82edc44c0a429b8f251c03d075ca99` (2 000 sats) paid `d1c15726…d083` → `confirmed` at the first 2 s tick → refund `f4b3c19c…841a` → `refunded`

Local dry run (same code, different throwaway mnemonic): invoice `inv_b67a9b33…1a9f` paid
`8cf39f07…7875`; the gateway reported the payment as `seen` at t+2 s and `confirmed` at t+4 s —
the transient state is observable when the poll tick lands between CheckTx and the block.

E2E (`npm run e2e:tachi`, gateway booted in-process with `ADAPTER_MODE=tachi`):

- invoice `inv_d5884327d79942c0a2c108be710a27c1` (5 000 sats) → real address
  `bcrt1p…` on change-chain index 0
- customer payment tx `d8fb214ede5a678a64e093262ca3b8572e081a5d06eeaec7721a5c0c2976146f`
  → first poller tick (t+0.8 s) saw it `committed` → invoice `confirmed`
- refund tx `698e31285df5a0b6e383b05764799abc915d98e617b726f4847e8c73b90ebf71`
  (till → customer) → invoice `refunded`
- balances: merchant 44 999 → 39 998 (till 39 999 → 34 998, invoice key 5 000);
  customer 10 000 → 4 999 → 9 999

## 5. Payouts: the vault path works for real — the blocker is a missing bridge

**Verified on `tachi-regtest-1` (2026-08-26, `npm run spike:vault`,
[docs/tachi-vault-spike.md](docs/tachi-vault-spike.md)).** The full Taurus
vault path ran end to end with the shipped SDK:

| Step | Result | Txid / id |
| --- | --- | --- |
| L1 funding wallet | faucet → 1 000 000 sats to our P2WPKH; aggregator `sync()` through the daemon's RPC proxy | `0269994eb2fce274d43c534aa52f609035a5a1d1cbe0819f933027fc758281ce` |
| `createVault` | 2-leaf P2TR (5-of-7 cooperative + CSV exit), quorum from `/tachi_validatorsPower`, **`csvBlocks=1` accepted** | vault A `bcrt1pnrud4…c99s`, vault B `bcrt1p45gf…y2h9` |
| `depositToVault` (L1) | 0.003 BTC into each vault | A `e4b6e9ec82e16e2ddcf70955c3473420c60edcae83f8987bc4e004a198f53dc4`, B `643a68dac299fb034f4ecc176be26eefc0c3bed1ee4a7fc17d37245703a8dce4` |
| `registerVault` (`TxVaultOpen`) | committed, `code 0`; daemon lists the vaults `state: open` | A ledger tx `072484e7f7c01b3d1a5851313261ae62d067f4351365120317ce89b04df76166` → vaultId `e5f83fa6aa8c2635a3570010f4185e21d8c937d8be71b70f2009e18c6b21f1aa`; B vaultId `b74be6cc8abfeb7c51bd47b06b52025685171d14e36adec520e3c8e759c7a03e` |
| **Unilateral exit** | `buildUnilateralExitPsbt` → **user signature only, no quorum** (3-item witness: sig, exit script, control block; `nSequence=1`) → **299 500 sats swept back to our P2WPKH, confirmed on L1** | `5bb2960bf27b6715228abe784a47bbb354b3aff3d7182e352fec882a7a67d0c3` |
| **Cooperative refund** | `buildRefundPsbt` → user-signed → `POST /tachi_signTransaction` returned **5 partial signatures from 5 distinct validators** → 10-item witness (5 validator sigs + 2 empty slots + user sig + 274-byte script + control block) → **confirmed on L1** into the `to_local` commitment output | `b78cdb628a118fdb95090601914dedbaab4ba3c895432fbb10ea7bf25982f86b` |

Cost and time: **782 sats** of L1 fees for the deposit + exit round trip;
**~30 minutes end to end** at regtest's fixed 10-minute block cadence with
`csvBlocks=1` (the SDK default of 1008 blocks would be ~7 days). The daemon's
watchtower (`mode: detection`) scanned the exit's block and recorded no
receipt — correct, an exit-leaf spend is not a breach — but the vault record
stays `open` afterwards.

**Why `initiatePayout` is still simulated — precisely.** Registering a funded
vault mints **no ledger VTXO**: after `TxVaultOpen` the vault address has
`getLockedVtxos` empty and a ledger balance of 0; the vault's value is its L1
funding UTXO. So there are **two separate value pools with no observed
bridge**: the *vault pool* (L1 custody, exitable) and the *ledger-VTXO pool*
(what merchants actually receive on invoices). A merchant can therefore exit
only funds they first deposited into a vault **from L1** — not their sales.
That, not time or SDK gaps, is what keeps payouts simulated: wiring the spike
into `initiatePayout` today would demonstrate the mechanism on the merchant's
own L1 deposit while leaving their receipts untouched. The adapter returns a
`failed` payout carrying this explanation rather than pretending.

`TxWithdraw` (wire type 5) exists in the daemon's tx types but the SDK ships no
builder or semantics for it, so it cannot be implemented honestly client-side.

**On "on-the-fly" exit.** Our reading of the shipped surface remains that there
is no direct ledger → L1 exit for plain-key VTXO holders; that reading is now
matched by the team's own words:

> "Yes, vault is the only vessel for the entry and exit. Regarding on-the-fly
> exit from Tachi to Bitcoin L1, we don't have cryptographic support for it
> just yet." — Tachi team, Telegram, Aug 2026

The spike shows the **vault-based** exit does work; the two statements are
consistent — the vault is the vessel, and what is missing is the on-the-fly
(plain-key) path.

**Open questions for the Tachi team (current):**

1. **Is there, or will there be, a ledger → vault bridge?** Can ledger VTXOs
   (invoice receipts) be moved into a vault's funding output — or otherwise
   redeemed to L1 — without an L1 deposit? Answering this makes
   `initiatePayout` roughly a **one-day job** on top of
   [scripts/tachi-vault-spike.ts](scripts/tachi-vault-spike.ts).
2. Should an observed exit-leaf spend transition the vault to a closed state on
   the ledger (it currently stays `open`), and is there a `TxVaultClose` a
   client should send?
3. What CSV value is considered safe on signet/mainnet, given regtest accepted
   `csvBlocks=1`?

Smaller caveats: fees are the daemon's `min_fee_sat` (1 sat on regtest); a
refund needs a *single* key holding `amount + fee` (fund the till); on-chain
balance via `scantxoutset` is a full-UTXO-set scan and is cached for 60 s; the
regtest daemon accepts a self-signed `TxDeposit` with no L1 backing (how ledger
value enters outside regtest is presumably vault deposit only — unverified).

## 6. Running it

```bash
# 1) key material (test coins only)
node -e "console.log(require('bip39').generateMnemonic())"

# 2) .env
ADAPTER_MODE=tachi
TACHI_MNEMONIC="…"
TACHI_NETWORK=regtest              # or signet + TACHI_RPC_URL=https://rpc-signet.tachibtc.com

# 3) fund the till key once (its address is in the boot log) with a ledger transfer and go
#    (regtest only: scripts/tachi-smoke.ts mints a self-signed ledger deposit; the L1 faucet does NOT credit the ledger)
npm run dev                        # logs: tachi: connected {chainId, height, tillAddress}
```

Node ≥ 22 is required in tachi mode (the SDK's engines floor). The mock is
untouched: `npm test` never touches the network; `npm run smoke:tachi` and
`npm run e2e:tachi` do.
