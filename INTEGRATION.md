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

## 5. Not implemented in real mode — and what it takes

**L1 payouts (cooperative withdrawal, unilateral exit).** Today the merchant's
funds are ledger VTXOs owned by plain keys. Moving value ledger → L1 needs one
of two things the shipped SDK does not give a plain-key holder:

1. **A Taurus vault**: `createVault` (2-leaf P2TR: cooperative 5-of-7 leaf +
   CSV exit leaf, quorum from `fetchConsensusQuorum`) → `depositToVault` (an L1
   transaction from a **P2WPKH** funding wallet, i.e. the wallet-aggregator with
   `scantxoutset` via the daemon's RPC proxy) → L1 confirmation →
   `registerVault` (`TxVaultOpen`). With a vault, cooperative withdrawal is
   `buildRefundPsbt → signRefundPsbtAsUser → cosignRefund (/tachi_signTransaction)
   → finalizeRefundPsbt → sendrawtransaction`, and unilateral exit is
   `buildUnilateralExitPsbt → sign → finalize → sendrawtransaction` after the
   CSV delay — daemon-free, the sovereignty path.
2. **`TxWithdraw`** (wire type 5) — exists in the daemon's tx types but the SDK
   ships no builder and no documentation of its semantics, so it cannot be
   implemented honestly from the client side.

In short: as far as the published SDK and docs go, **there is no on-the-fly
ledger → L1 exit for plain-key VTXO holders today** — that is our reading of
the shipped surface, not a quoted Tachi statement; the open questions below are
how we asked them to confirm or correct it.

Regtest L1 blocks are slow (minutes to hours between blocks during this
session), which is why the vault path was not attempted in this timebox. The
adapter therefore returns a `failed` payout carrying that explanation rather
than pretending. The dashboard's Payouts view shows it as such.

**Open questions for the Tachi team:**

1. *Is there a supported ledger → L1 withdrawal for plain-key VTXO holders (the
   `TxWithdraw` wire type), or is a registered Taurus vault the only exit — and
   if so, can a vault be funded from ledger VTXOs rather than from an L1 P2WPKH
   wallet?* (Unblocks real-mode cooperative withdrawal + unilateral exit.)
2. *The regtest daemon accepts a **self-signed `TxDeposit` with no L1 backing**
   (fee ≥ 1 sat) — we used that to fund keys. Is that regtest-only? On signet /
   mainnet, what is the sanctioned way ledger value comes into existence for a
   merchant — vault deposit only?* (Determines the onboarding story outside regtest.)

Smaller caveats: fees are the daemon's `min_fee_sat` (1 sat on regtest); a
refund needs a *single* key holding `amount + fee` (fund the till); on-chain
balance via `scantxoutset` is a full-UTXO-set scan and is cached for 60 s.

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
