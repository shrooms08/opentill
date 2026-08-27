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

Both halves of that exit already work. `TxLockForVault` was assumed to be the
join — 5.3e shows it is a ledger-side flag with no L1 effect, so this route
does not pay receipts out either. See 5.4.

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
our attempt at this — result in 5.3d.

### 5.3d Lock spike result: blocked on an unnamed post-signature rule

Run 2026-08-26 on `tachi-regtest-1`, full transcript in
[docs/tachi-lock-spike.md](docs/tachi-lock-spike.md). Everything *around* the
lock step ran for real:

| Step | Result | Evidence |
| --- | --- | --- |
| merchant receipt | a customer key paid the merchant key 50 000 sats by plain ledger transfer, exactly as an invoice payment does | receipt VTXO `0de9e7ddc71c9aa924e3672e0251c2b69c890b56c33d9c118b4b1c28af7f7e2c` |
| vault for that key | `createVault` → L1 deposit `68b21f0e7a536cbb0d198e97a6cad7afeec0112787cbc8b72088e935c716be16` → `registerVault` committed `code 0` | vaultId `24e194845463f1940f5427507190697bf2bffea648f1c3ebd2d4686391f06adb` |
| **`TxLockForVault`** | **rejected — 15 distinct conforming shapes, every one `code 12 invalid transaction format`**; the receipt VTXO is untouched | §3–§3c of the transcript |
| lock verify / exit / cooperative | not reached | — |

What the daemon actually does, established by a bogus-signature probe (a shape
that passes the format layer fails *later* with `code 3 invalid signature`,
so the checks separate):

- **`Outputs` must be non-empty.** `outputs=[]` is rejected `code 12` *before*
  signature verification — the generic format check, as suspected in 5.3c. A
  zero-value placeholder does not help.
- **With non-empty outputs the lock envelope passes the generic format check**
  (bogus signature → `invalid signature`), and `/tachi_txDecode` parses it as
  `type: "lock"` with correct vin/vout — the SDK's transfer wire layout is fine
  for `0x06`.
- **With a valid signature the identical shape is rejected `code 12` again**: a
  **lock-specific validation that runs after signature verification reuses the
  format error code**. Nothing the stated contract allows changes it — PSBT
  unfinalized / genuinely finalized (real input with `finalScriptWitness`,
  exactly one P2TR output paying the vault's own address) / absent; PSBT output
  value equal to the VTXO amount, amount − fee, or less; ledger output to the
  owner or to the vault's taproot key; ledger fee 1 or 0; input `txid` zero, or
  the funding txid in internal or display byte order.
- **`/tachi_txValidate` is not evidence.** It rejects *valid, routinely
  committed* transfers with `input 0 sigscript: need 16705 bytes` — a decoder
  bug on that endpoint (the README's "false negatives", now characterised).
- Side findings: types `5` (`withdraw`) and `7` (decodes as `unlock`) pass the
  generic format check with the plain transfer shape; type `2` does not.

So at least one requirement of `TxLockForVault` was not in the contract we were
given, and `code 12` was the only signal the daemon exposed for it. Tachi then
traced the path in source — 5.3e has the rules, and 5.4 has the conclusion that
makes them moot for payouts.

### 5.3e What `TxLockForVault` actually does (Tachi team, Telegram, Aug 2026, source-traced)

Tachi read the full lock/unlock path in their daemon and answered both what the
rejections were and what a successful lock would have meant:

- **`TxLockForVault` only parses the PSBT to extract the vault address for
  bookkeeping and flips a `Locked` flag on the VTXO. It never broadcasts
  anything to Bitcoin.** `TxUnlockFromVault` is the exact mirror — also no L1
  activity. `TxWithdraw` has no special-case handler at all (5.3b). Locking is
  purely an **off-chain, ledger-side hold**.
- Therefore **there is no daemon-side mechanism today that pays anything out on
  L1 against a locked VTXO.** In their words: *"a real gap, not a hidden design
  choice."*

For whoever picks this up once that gap is closed, the validation rules we hit
(the reason for every `code 12` in 5.3d):

- `code 12` is reused for a **post-signature cross-check of the TachiTx fields
  against the parsed PSBT**: same input count; same `txid`/`vout` per input;
  same output count; **byte-exact output amounts**.
- Neither cooperative-leaf signing nor output-value equality to the VTXO amount
  is enforced.
- A lock's `Outputs` must be non-empty with **`Amount > 0` matching the PSBT
  output exactly**, and `Owner` a 32-byte x-only key — not cross-checked for
  locks; set it to the VTXO's existing owner.
- `/tachi_txValidate`: Tachi believes the hex we validated differed from what
  we broadcast; unresolved on both sides. Treat **broadcast verdicts as the
  only truth**.

The spike's vaults and the untouched receipt remain on regtest, but there is no
reason to resume `npm run spike:lock`: a committed lock would flip a flag and
create no L1 value to exit.

### 5.4 Why `initiatePayout` is still simulated — precisely

**Because the ledger → L1 path for merchant receipts does not exist in the
protocol today, by any route.** Not a missing SDK builder, not a gap in our
implementation. Tachi traced every candidate in source (5.3b, 5.3e):

- `TxWithdraw` — no handler; a "payout" on it commits and moves nothing.
- `TxLockForVault` / `TxUnlockFromVault` — an off-chain hold: parse the PSBT for
  the vault address, flip a `Locked` flag, mirror it back. No L1 activity.
- There is **no daemon-side mechanism that pays anything out on L1 against a
  locked VTXO** — "a real gap, not a hidden design choice."

This also explains the first vault spike (5.1) exactly: the unilateral exit and
the cooperative refund we proved on L1 move **a vault's own L1 funding UTXO** —
the coins deposited from L1 at `depositToVault`. That is why they only ever
worked for self-deposited funds. Locking a merchant receipt into that vault
would not have created any L1 value to exit; the exit would still have moved
only the deposit.

What *is* real, and stays real: receiving, confirmation and refunds on the
ledger (`ADAPTER_MODE=tachi`, 5.1–5.3), and the vault's own L1 exits for funds a
merchant deposits from L1 themselves. What OpenTill therefore does:
`initiatePayout` in real mode returns a `failed` payout carrying this
explanation, and `ADAPTER_MODE=mock` demonstrates the payout/exit UX the product
is designed around. When Tachi ships ledger → L1 offboarding, the adapter's
existing build → sign → `broadcastTxSync` → assert `code 0` → wait-for-commit
path and the proven vault exits are the pieces it slots into; until then no
amount of client work changes the outcome.

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

**One item: will Tachi implement ledger → L1 offboarding for VTXO holders?**
That — and only that — unblocks real merchant payouts (5.4). Every
lock-related question (post-signature rules, PSBT leaf, output values,
`Outputs` contents) is closed by 5.3e; the `/tachi_txValidate` discrepancy is
noted there as unresolved but immaterial (broadcast verdicts are the truth).
Items carried from OpenSluice (delegated LP custody, broadcast `code=5`, nonce
behavior) are tracked in that project.

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
