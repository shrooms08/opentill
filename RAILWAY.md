# Deploying OpenTill on Railway — runbook

Two Railway services in one project, built from this repo's `Dockerfile` (config: [`railway.json`](railway.json)):

| Service | What it is | Variables file |
| --- | --- | --- |
| `opentill-live` | **Real** Tachi settlement on `tachi-regtest-1` | `.env.railway-live` |
| `opentill-demo` | **Mock** settlement with the "Simulate payment" button | `.env.railway-demo` |

Run every command **from the repo root** (`cd` into the `opentill` folder first), in a macOS or Linux terminal. Nothing here prints a secret. Commands were written against Railway CLI **5.70.0**; check yours with `railway --version`.

Where the secret values come from:

- `.env.railway-demo` — already filled in (fresh API key + webhook secret). Nothing to do.
- `.env.railway-live` — API key (same as your local `.env`) and webhook secret are filled in. **`TACHI_MNEMONIC` is empty; step 2 fills it.**
- Your Railway account — you log in in step 1.

To read a key later (e.g. to paste into the dashboard), open the file in a text editor. Don't `cat` it on a shared screen.

---

## 1. Install the CLI and log in

```bash
npm install                 # repo dependencies — steps 2 and 5 use them
npm i -g @railway/cli
railway --version
railway login
```

`railway login` opens a browser; approve it there.

## 2. Give the live service its own Tachi mnemonic (recommended: a NEW one)

This writes a brand-new 12-word mnemonic into `.env.railway-live` without showing it:

```bash
node -e 'const fs=require("fs");const f=".env.railway-live";const s=fs.readFileSync(f,"utf8");if(!/^TACHI_MNEMONIC=$/m.test(s)){console.error("TACHI_MNEMONIC is already set — not touching it");process.exit(1)}fs.writeFileSync(f,s.replace(/^TACHI_MNEMONIC=$/m,"TACHI_MNEMONIC="+require("bip39").generateMnemonic()));console.log("TACHI_MNEMONIC written to .env.railway-live (not shown)")'
```

Then **back it up**: open `.env.railway-live` in a text editor and copy the `TACHI_MNEMONIC` line into your password manager. Railway can show it to you later, but don't rely on that alone.

Why a new mnemonic and not the Fly one:
- **Collision:** the Fly instance is still running and still uses the old mnemonic. Two gateways deriving the same keys would hand out the same invoice addresses.
- **Empty volume:** with the old mnemonic, a fresh `/data` would restart invoice keys at #0 and reuse old invoice addresses. The gateway now **refuses to boot** in that case ("TACHI_MNEMONIC was already used by an OpenTill instance…").

## 3. Create the project and the `opentill-live` service with a volume

```bash
railway init --name opentill
railway add --service opentill-live
railway service link opentill-live
railway volume add --service opentill-live --mount-path /data
```

`railway init` links this folder to the new project. If it asks for a workspace, pick yours.

## 4. Load all live variables (values never printed)

```bash
sh scripts/railway-load-env.sh .env.railway-live opentill-live
```

You should see one `set   NAME` line per variable, `skip  OPENTILL_PUBLIC_URL (empty)`, and `done: … variables set`. The script stops before sending anything if a value is still a placeholder or the mnemonic is empty.

Check the names landed in the Railway dashboard, which masks values: run `railway open`, then click **opentill-live → Variables**. Avoid `railway variable list` on a shared screen, because it can print values.

## 5. Deploy, give it a public URL, set `OPENTILL_PUBLIC_URL`

```bash
railway up --service opentill-live --ci
railway domain --service opentill-live --port 8080
```

- `railway up --ci` uploads the folder (gitignored files such as `.env*` are **not** uploaded), builds the Dockerfile, and streams the build log. Wait for it to finish.
- `railway domain` prints a URL like `https://opentill-live-production-xxxx.up.railway.app`. **That is `<LIVE_URL>`** — copy it.

Set it as the public URL. This is not a secret, and setting it triggers a redeploy:

```bash
railway variable set OPENTILL_PUBLIC_URL=<LIVE_URL> --service opentill-live
```

(This is optional — without it the app falls back to Railway's injected `RAILWAY_PUBLIC_DOMAIN` — but it makes the value explicit.)

Then fund the new till so refunds work. Its address is in the boot log (`tillAddress`); this command derives the same key from the mnemonic and mints 50 000 regtest sats onto the Tachi ledger (sanctioned on regtest):

```bash
TACHI_MNEMONIC="$(sed -n 's/^TACHI_MNEMONIC=//p' .env.railway-live)" npm run fund:tachi -- --sats 50000
```

It prints `deposit 50000 sats → bcrt1p…` then `committed=true … balance now: 50000 sats`. That address must equal `tillAddress` in the logs (step 8).

## 6. Same for `opentill-demo`

```bash
railway add --service opentill-demo
railway service link opentill-demo
railway volume add --service opentill-demo --mount-path /data
sh scripts/railway-load-env.sh .env.railway-demo opentill-demo
railway up --service opentill-demo --ci
railway domain --service opentill-demo --port 8080
```

The last command prints **`<DEMO_URL>`**. Then:

```bash
railway variable set OPENTILL_PUBLIC_URL=<DEMO_URL> --service opentill-demo
```

## 7. Restore the Fly backup onto the live volume

**Skip.** The recommendation is a fresh start with a new mnemonic (step 2), so `../opentill-backup/opentill-live-data.tgz` stays a cold backup. Keep it: together with the old Fly mnemonic it is what recovers the old invoices and the ~62 000 regtest sats on the old keys.

## 8. Verify

Health (no key needed):

```bash
curl -s <LIVE_URL>/healthz     # {"ok":true,"adapterMode":"tachi","dbOk":true}
curl -s <DEMO_URL>/healthz     # {"ok":true,"adapterMode":"mock","dbOk":true}
```

The API keys work. Each should print `200`, and the key is read from the file, never shown:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(sed -n 's/^OPENTILL_API_KEY=//p' .env.railway-live)" <LIVE_URL>/api/stats
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(sed -n 's/^OPENTILL_API_KEY=//p' .env.railway-demo)" <DEMO_URL>/api/stats
```

Logs show Tachi connected and the gateway ready:

```bash
railway logs --service opentill-live --lines 300 | grep -E "tachi: connected|gateway ready|refusing|not writable"
railway logs --service opentill-demo --lines 300 | grep -E "gateway ready|not writable"
```

Expect `"tachi: connected"` with `"chainId":"tachi-regtest-1"` and a `tillAddress` matching step 5's funding address, then `"opentill gateway ready"` with your `publicUrl`. On the demo, expect `"devPublicSimulate":true`.

- **`not writable`** — `RAILWAY_RUN_UID=0` is missing. Re-run step 4 or 6.
- **`refusing to boot`** — the mnemonic was used before; see step 2.

End-to-end real payment on the live service (the rehearsal for the demo):

```bash
LIVE=<LIVE_URL>
KEY="$(sed -n 's/^OPENTILL_API_KEY=//p' .env.railway-live)"
INV=$(curl -s -X POST "$LIVE/api/invoices" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"amountSats":"2000","memo":"Railway smoke"}')
echo "$INV" | node -pe 'const i=JSON.parse(require("fs").readFileSync(0));`${i.id}\n${i.address}\n${i.checkoutUrl}`'
npm run pay:tachi -- "$(echo "$INV" | node -pe 'JSON.parse(require("fs").readFileSync(0)).address')" 2000
sleep 6; curl -s "$LIVE/api/invoices/$(echo "$INV" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')" -H "Authorization: Bearer $KEY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status'
```

The last line should print `confirmed`. `pay:tachi` pays from the regtest "customer" key in the local file `.tachi-smoke-state.json` (≈43 000 sats on 2026-11-04). Open the printed `checkoutUrl` in a browser to see the checkout flip to confirmed.

Demo pay button: open `<DEMO_URL>/dashboard`, log in with the demo key, go to New charge, and create a charge. The checkout should show **Simulate payment**.

## 9. Stop the Fly machines

So two instances never run at once. Note that Fly's opentill-live still accepts the **old, published** API key: its key rotation is staged, not deployed.

```bash
fly machine list -a opentill-live
fly machine stop <MACHINE_ID> -a opentill-live
fly machine list -a opentill-demo
fly machine stop <MACHINE_ID> -a opentill-demo
```

`<MACHINE_ID>` is the `ID` column of the list. On 2026-11-04 opentill-live's machine was `8654742b665368`. Confirm with `curl -s https://opentill-live.fly.dev/healthz`, which should fail or time out.

**If the billing lock blocks `fly machine stop`:**
- **Railway still works.** With a new mnemonic (step 2), Railway shares no keys with Fly.
- **What remains exposed** is Fly's own regtest float: ~44 000 sats on its till, refundable by anyone holding the old published key. Those are test coins only.
- **To close it:** settle the Fly bill and run `fly machine stop` (or `fly secrets deploy -a opentill-live` to activate the staged key), or ask Fly support to suspend the apps.
- **Don't** point anyone at the `*.fly.dev` URLs any more.

## 10. Update the README links

In `README.md`, under **Try it**, replace the two "_URL added after the Railway deploy_" placeholders with `<DEMO_URL>/dashboard` and `<LIVE_URL>/dashboard`. Then commit.

---

### Later deploys

```bash
railway up --service opentill-live --ci
railway up --service opentill-demo --ci
```

Variables changed with `railway variable set` (without `--skip-deploys`) redeploy automatically. To restart without rebuilding, run `railway service redeploy --service <name> --yes`.
