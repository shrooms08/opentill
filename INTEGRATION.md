# OpenTill × Tachi — how the integration works

**Status as of 2026-08-25: real settlement is live on Tachi regtest** for the
whole merchant-facing receive path — per-invoice addresses, payment detection,
`seen → committed` confirmation, and refunds — proven end to end against
`https://rpc-regtest.tachibtc.com` with real transaction ids (below). The
mock adapter remains the test/demo/CI adapter; `ADAPTER_MODE=tachi` selects
the real one behind the same `TachiAdapter` interface.

What is **not** implemented in real mode: **payouts to L1** — cooperative
withdrawal and unilateral exit. The route exists — lock a receipt VTXO into a
vault with `TxLockForVault`, then take the vault exit this repo has already
driven for real on L1 — but the shipped SDK has no builder for the lock step.
§5 has the verified vault exit, the corrected path, and exactly what is missing.

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
| `initiatePayout` | **not implemented** — returns a `failed` payout with the reason: no SDK builder for `TxLockForVault` yet (§5.4) | unit test |
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

## 5. Payouts: every path exists on the protocol — the gap is SDK tooling

### 5.1 What ran for real (vault path, `npm run spike:vault`)

Verified on `tachi-regtest-1`, 2026-08-26, full transcript in
[docs/tachi-vault-spike.md](docs/tachi-vault-spike.md):

| Step | Result | Txid / id |
| --- | --- | --- |
| L1 funding wallet | faucet → 1 000 000 sats to our P2WPKH; aggregator `sync()` through the daemon's RPC proxy | `0269994eb2fce274d43c534aa52f609035a5a1d1cbe0819f933027fc758281ce` |
| `createVault` | 2-leaf P2TR (5-of-7 cooperative + CSV exit), quorum from `/tachi_validatorsPower`; `csvBlocks=1` (test-only, see 5.5) | vault A `bcrt1pnrud4…c99s`, vault B `bcrt1p45gf…y2h9` |
| `depositToVault` (L1) | 0.003 BTC into each vault | A `e4b6e9ec82e16e2ddcf70955c3473420c60edcae83f8987bc4e004a198f53dc4`, B `643a68dac299fb034f4ecc176be26eefc0c3bed1ee4a7fc17d37245703a8dce4` |
| `registerVault` (`TxVaultOpen`) | committed, `code 0`; daemon lists the vaults `state: open` | A ledger tx `072484e7f7c01b3d1a5851313261ae62d067f4351365120317ce89b04df76166` → vaultId `e5f83fa6aa8c2635a3570010f4185e21d8c937d8be71b70f2009e18c6b21f1aa`; B vaultId `b74be6cc8abfeb7c51bd47b06b52025685171d14e36adec520e3c8e759c7a03e` |
| **Unilateral exit** | `buildUnilateralExitPsbt` → **user signature only, no quorum** (3-item witness; `nSequence=1`) → **299 500 sats swept back to our P2WPKH, confirmed on L1** | `5bb2960bf27b6715228abe784a47bbb354b3aff3d7182e352fec882a7a67d0c3` |
| **Cooperative refund** | `buildRefundPsbt` → user-signed → `POST /tachi_signTransaction` returned **5 partial signatures from 5 distinct validators** → 10-item witness → **confirmed on L1** into the `to_local` commitment output | `b78cdb628a118fdb95090601914dedbaab4ba3c895432fbb10ea7bf25982f86b` |

782 sats of L1 fees for the deposit + exit round trip; ~30 minutes end to end
at regtest's fixed 10-minute cadence. **The funds exited were deposited from L1
for the spike, not merchant receipts.**

### 5.2 Why the spike could only exit self-deposited funds

`TxVaultOpen` registers an L1-funded vault **directly against an L1 outpoint**
and never touches the ledger-VTXO pool (Tachi team, Telegram, Aug 2026). That
is exactly what we observed: after registration the vault address had
`getLockedVtxos` empty and a ledger balance of 0 — the vault's value *was* its
L1 funding UTXO. Merchant receipts, by contrast, are plain-key ledger VTXOs.
The step we did not know existed is **`TxLockForVault`** (5.3): it is what
moves a ledger VTXO into vault custody. Our spike simply never used it.

### 5.3 The three ledger → L1 paths (Tachi team, Telegram, Aug 2026, paraphrased)

1. **`TxVaultOpen`** — registers an L1-funded vault against an L1 outpoint.
   Never touches ledger VTXOs. What the spike exercised.
2. **`TxLockForVault` / `TxUnlockFromVault`** — **the ledger → vault bridge**:
   lock an existing ledger VTXO under a vault address, or release it back. This
   is the path for putting merchant-receipt VTXOs under vault custody, and thus
   under the quorum-cosigned refund and unilateral-exit guarantees of 5.1.
3. **`TxWithdraw`** (wire type 5) — described as a **plain ledger → L1 exit
   needing no vault**. **Retracted days later; see 5.3b.**

Tachi's recommendation at the time: `TxWithdraw` is the more direct fix for
"real sales → real payout"; use `TxLockForVault` first only if you specifically
want the quorum-cosigned / unilateral-exit guarantees on those funds.

This retires the claim, made in earlier revisions of this file and echoed by an
earlier Tachi message ("vault is the only vessel for the entry and exit …
we don't have cryptographic support for [on-the-fly exit] just yet" — Tachi
team, Telegram, Aug 2026), that no ledger → L1 path exists for plain-key VTXO
holders. A path does exist — but it is the bridge into vault custody
(`TxLockForVault`) plus the vault exit of 5.1, **not** `TxWithdraw`, which 5.3b
retracts. Two corrections in one month, in opposite directions; both are kept
here on purpose, because the sequence is the useful part.

### 5.3b Correction: `TxWithdraw` is a dead end (Tachi team, Telegram, Aug 2026)

Tachi inspected their own source and **withdrew the recommendation above**.
Paraphrasing them: `TxWithdraw` (0x05) is **unimplemented, not merely
undocumented**. It has zero special-case handling in consensus or mempool beyond
generic format checks — it is validated exactly like a transfer (inputs,
outputs, valid signature, balance) and simply moves VTXOs around the ledger.
There is **no L1 broadcast, no destination-address semantics, and nothing
withdraw-specific implemented**. There is no payload for us to mirror because
the daemon does nothing with the type.

Stated plainly, because it nearly cost us: a payout built on `TxWithdraw` would
be accepted, would commit with `code 0`, and would move **nothing** to L1. It
would look exactly like a successful payout. 5.4's refusal to hand-assemble an
undocumented payload is the only reason we did not ship that.

So the route from merchant receipts to L1 is **not** `TxWithdraw`. It is:

> receipts (plain-key ledger VTXOs) → **`TxLockForVault`** into a vault → the
> vault exit proven in 5.1 — cooperative refund
> (`b78cdb628a118fdb95090601914dedbaab4ba3c895432fbb10ea7bf25982f86b`) for
> normal payouts, unilateral exit
> (`5bb2960bf27b6715228abe784a47bbb354b3aff3d7182e352fec882a7a67d0c3`) as the
> sovereignty backstop.

Both halves of that exit already work. `TxLockForVault` is the join.

### 5.3c `TxLockForVault` (0x06) — the wire contract

Tachi gave us the contract directly, so this is implementable without a builder
to copy:

- Same base fields as any transaction: inputs, outputs, fee, `pubKey`,
  `signature`, `nonce`.
- **`PSBTPayload` is required** and must be a **finalized PSBT with exactly one
  P2TR output**. The daemon decodes that output's witness program directly into
  the vault's bech32m address. Zero taproot outputs fails validation; more than
  one fails validation.
- Referenced input VTXOs must exist and must not already be locked.
- Only a fee-balance check applies, since the lock creates no new VTXO outputs —
  though the generic format check still expects `Outputs` to be non-empty. What
  that path actually accepts for a lock is worth confirming empirically rather
  than assuming.
- To build one: construct a PSBT whose single output pays the target vault's
  taproot address (the same address derived at vault open), finalize it, and put
  the raw bytes in `PSBTPayload`.

`TxUnlockFromVault` is the corresponding release path. `npm run spike:lock` is
our attempt at this; results will land in
[docs/tachi-lock-spike.md](docs/tachi-lock-spike.md).

### 5.4 Why `initiatePayout` is still simulated — precisely

**An SDK/tooling gap, not a protocol gap.** The shipped TypeScript SDK
(`@tachibtc/taurus-vault-core` 0.3.3) provides **no builder for
`TxLockForVault` / `TxUnlockFromVault`**. Every other ledger transaction we send
(`TxDeposit`, `TxTransfer`, `TxVaultOpen`) has an SDK builder whose wire
encoding we could verify against the daemon; hand-assembling an undocumented
payload and broadcasting it would be guessing with real (test) money, so we
don't.

That caution is now vindicated rather than merely prudent. The SDK also exports
a `TxWithdraw` type constant, and Tachi initially pointed us at it as the
simpler vault-free exit — but the type is unimplemented (5.3b), so building on
it would have produced a payout that committed and moved nothing. Refusing to
guess at a payload is what kept that out of the product.

`TxLockForVault` is a different case: its contract **is** specified (5.3c), so
it needs building and verifying rather than waiting on Tachi. `npm run
spike:lock` is that work. Until it lands the adapter returns a `failed` payout
carrying this explanation, and `ADAPTER_MODE=mock` demonstrates the payout/exit
UX. Once the lock step is proven, `initiatePayout` becomes two stages on the
adapter's existing build → sign → `broadcastTxSync` → assert `code 0` →
wait-for-commit path: lock the receipt VTXO into the vault, then run the exit
that 5.1 already proved.

### 5.5 Also answered

- **`TxVaultClose` (0x12) is defined but not wired.** The daemon's vault
  `State` field is hardcoded `"open"` because the closing/closed/breaching
  writer isn't implemented, and there is no client-side `TxVaultClose` to send.
  This explains why vault A still reads `open` after its funding outpoint was
  spent by our exit. **Track vault liveness from your own L1 observation of the
  exit-leaf spend, not from the daemon's reported state.** (Tachi team, Telegram, Aug 2026.)
- **CSV.** There is no protocol minimum beyond `> 0` and `<= 65535`. Our
  `csvBlocks=1` was accepted only because nothing stops it — **"not a signal
  it's safe."** **1008 blocks (~7 days) is the conventional default**; the real
  lower bound should be derived from the operator's own monitoring latency
  (how fast you would notice and react to a stale-state broadcast). Treat the
  spike's `csvBlocks=1` as test-only. (Tachi team, Telegram, Aug 2026.)
- **Self-signed deposits (former open question #2).** Accepted on **both regtest
  and signet**; the L1 verification gate is **mainnet-only**, where each
  validator independently verifies the claimed deposit against its own
  `bitcoind` (amount and block height/timestamp must match exactly), signs an
  attestation, and the deposit finalizes once attestations clear a threshold.
  So `scripts/tachi-fund.ts` is legitimate testnet behavior, a signet
  deployment is feasible with the current funding approach, and a mainnet
  adapter must wait for attestation — not `code 0` — before crediting (see GAPS.md).

### 5.6 Still open

1. **SDK builder for `TxLockForVault` / `TxUnlockFromVault`** — the only thing
   between OpenTill's receipts and a real payout. Unlike the retracted
   `TxWithdraw` ask, this is not blocked on Tachi: the wire contract is specified
   (5.3c) and the exit on the far side is proven (5.1), so it is ours to build
   and verify (`npm run spike:lock`). *(The earlier ask — a payload reference for
   `TxWithdraw` — is closed: there is nothing to reference, because the type is
   unimplemented.)*
2. Carried from OpenSluice, tracked here for completeness: delegated LP custody
   semantics; the meaning of broadcast `code=5`; nonce behavior (we observed the
   account nonce staying at 0 after committed txs — the adapter always reads
   `getAccountNonce` before signing and never assumes increments).

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
#    (regtest/signet: scripts/tachi-fund.ts mints a self-signed ledger deposit — sanctioned testnet behavior,
#     L1 verification is mainnet-only; the L1 faucet does NOT credit the ledger)
npm run dev                        # logs: tachi: connected {chainId, height, tillAddress}
```

Node ≥ 22 is required in tachi mode (the SDK's engines floor). The mock is
untouched: `npm test` never touches the network; `npm run smoke:tachi` and
`npm run e2e:tachi` do.
