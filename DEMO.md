# OpenTill — stage runbook

This is for whoever presents. You don't need to read code. Every step says what to click or type, and what the screen should show next.

| What | Where |
| --- | --- |
| **Live** (real Tachi settlement, regtest) | https://opentill-live-production.up.railway.app/dashboard |
| **Demo** (mock settlement, has a "Simulate payment" button) | https://opentill-demo-production.up.railway.app/dashboard |
| Customer refund address (the `pay:tachi` wallet; public, safe to show) | `bcrt1p5y7g3w5ac0g8wajqsppx0855nk64yq6xjajyje8h48n7fj8kvyus6zfu4g` |

> **Never show the API keys on screen.** They live only in two local files. Copy each one straight into the login box, and close the file before you share your screen.

---

## A. Before you go on stage (≈10 minutes, on good wifi)

### A1. Terminal

Open a terminal in the `opentill` folder and run:

```bash
cd ~/Projects/opentill
npm run preflight
```

You should see seven `PASS` lines and `ALL PASS`. It takes about 2 seconds. Any `FAIL`: see [F. Failure playbook](#f-failure-playbook) before going on.

| Check | What it guards |
| --- | --- |
| live /healthz (tachi) | live gateway is up and on real settlement |
| demo /healthz (mock) | demo gateway is up |
| live /api/stats with live key | your live key works |
| demo spendable > 0 | the demo has money to show payouts with |
| Tachi RPC reachable | the Tachi node is up and synced |
| live till ≥ 10,000 sats | refunds can be paid |
| pay:tachi customer ≥ 25,000 sats | the "customer wallet" can pay invoices |

Leave this terminal open and make the font large: `⌘ +` a few times. You will type one command into it on stage.

Optional, only if you want to show the shop checkout (section C3): start the local demo shop now, because the first build takes 3–4 minutes:

```bash
docker compose -f docker-compose.demo.yml up --build
```

Leave it running in its own terminal tab.

### A2. Browser tabs (Chrome), in this order

1. **Live dashboard:** https://opentill-live-production.up.railway.app/dashboard
2. **Demo dashboard:** https://opentill-demo-production.up.railway.app/dashboard
3. *(optional)* **Demo shop:** http://localhost:4000. This only works while the Docker command from A1 is running.

### A3. Log in to each dashboard

Each dashboard opens on a box asking for an **API key**, with an **Unlock** button.

- **Live tab:** open `.env.railway-live` in VS Code. Line 11 starts with `OPENTILL_API_KEY=`. Copy **everything after the `=`**, paste it into the box, and click **Unlock**.
- **Demo tab:** same, from `.env.railway-demo`, line 11, `OPENTILL_API_KEY=`.
- Close both files afterwards.

The key is remembered **only in that tab**. A new tab, or closing the tab, asks for it again. Links the dashboard opens itself (checkout, "View on Tachi") don't need it.

### A4. Make JSON readable

"View on Tachi" links open the Tachi node's raw JSON. In Chrome, tick the **"Pretty-print"** checkbox at the top of the first JSON page you open. Chrome remembers it. Do this once now with the live till link: live tab → **Overview** → **View till on Tachi ↗**.

### A5. Quick look

- Live tab → **Overview**: the orange card shows about **100 000 sats** spendable, plus a **View till on Tachi ↗** link.
- Demo tab → **Overview**: revenue and an orange spendable card of about **29 000 sats**. A thin "mock mode" bar at the bottom is expected.

---

## B. Live flow (real Tachi payment, ≈90 seconds)

Use the **live** tab.

1. **Create the charge.**
   - Click **New charge** in the left menu, type `2000`, and optionally a memo like `Flat white`. Click **Create charge**.
   - *Screen:* big QR, **2 000 sats**, "Waiting · 14:59" counting down.
2. **Open the customer's checkout page.**
   - Click **Invoices** in the left menu. The top row is your 2 000-sat charge, status **pending**. Click that row.
   - A side panel opens. Click **Open checkout ↗** at the top. A new tab opens: this is what the customer sees.
   - *Screen:* merchant header, "WAITING", **2 000 sats**, QR code, the address with a **Copy** button, a countdown.
3. **Pay it from the customer wallet.**
   - On the checkout tab, click **Copy** next to the address.
   - In the terminal, type the following, pasting the address where it says `<paste address>`:

     ```bash
     npm run pay:tachi -- <paste address> 2000
     ```

     A complete example looks like `npm run pay:tachi -- bcrt1pdxn0s0qgjyuexw4gwe9wt9vged7pcq6rg5hhkmhtfrjq5y3lxz8safv3wl 2000`.

   - The script takes the **address**, not the invoice id. The amount must be exactly `2000`.
   - *Terminal:* `pay 2000 sats → bcrt1p…  code=0 … hash=…`, then a few seconds later `committed=true  customer balance now: … sats`.
4. **Watch the checkout flip.** Switch to the checkout tab. Within a few seconds of `committed=true`:
   - It may show **RECEIVED · Finalizing** briefly.
   - It then turns green: **CONFIRMED · Paid · 2 000 sats**. Nobody clicked anything; the page updated itself.
5. **Click "View on Tachi ↗"** under the invoice/created rows.
   - *Screen:* a JSON page with `"type":"transfer"`, `"state":"committed"`, `"status":{"code":0}`, and an output of `"amount":2000`. This is the payment as recorded on the Tachi ledger.
6. **Refund it from the dashboard.**
   - Back to the **live** dashboard tab. The invoice panel now shows a green **confirmed** pill and **Paid 2 000 sats**. Under *Payments* there is a row with **View tx ↗**. If the panel doesn't refresh, close it with **×** and click the row again.
   - Scroll to **Refund** and click **Refund 2 000 sats…**.
   - In *Destination address*, paste the customer address:

     ```
     bcrt1p5y7g3w5ac0g8wajqsppx0855nk64yq6xjajyje8h48n7fj8kvyus6zfu4g
     ```

   - Click **Send refund**. *Screen:* a spinner, "Sending 2 000 sats…". Then, usually within 5–10 seconds, a green box: **Refund sent · 2 000 sats · <tx hash>**.
   - The pill changes to **refunded**. A **Refund tx** field appears with its own **View on Tachi ↗** link.
7. **Click the refund's "View on Tachi ↗".**
   - *Screen:* JSON with `"type":"transfer"`, `"state":"committed"`, and an output of `"amount":2000` to the customer.
   - Money went in, and the same money came back out, both visible on the ledger.

Each run costs the customer wallet 2 001 sats (1-sat fee) and the till 2 001 sats net, once the refund comes back. Preflight says whether you can run it again.

---

## C. Demo-instance flow (mock settlement)

Use the **demo** tab. Everything here is simulated. The bar at the bottom says so.

### C1. A payment in one click

- **New charge** → `5000` → **Create charge**. Then **Invoices** → top row → **Open checkout ↗**.
- The checkout has a dashed **Simulate payment** button under the card. Click it.
- *Screen:* the checkout goes green, **Paid**. Tip: to show the full-screen orange "Paid" flood, simulate while the dashboard is still on the **New charge** screen, using a second checkout tab.

### C2. Payouts (money out to on-chain Bitcoin)

Go to **Payouts** in the left menu. The page shows two balance cards and a **Withdraw** card with two choices.

1. **Cooperative withdrawal** (the normal, fast path):
   - Keep it selected, type `5000` in *Amount*, and type any address, e.g. `bc1qdemocoldstorage`. Click **Withdraw**.
   - *Screen:* "Payout initiated ✓". In *Payout history*, the row moves **initiated → broadcasting → settled** within seconds. The on-chain card goes up by 5 000.
2. **Unilateral exit** (the escape hatch). **Do this last**: it sweeps the *whole* balance, so the demo spendable goes to 0.
   - Click **Unilateral exit**, enter an address, and click **Start unilateral exit…**.
   - A confirm box explains the sweep. Click **Exit now**.
   - *Screen:* an amber banner and a block countdown from 12. It settles after about 25 seconds, and the on-chain card holds everything.
   - To refill the demo afterwards, repeat C1 a couple of times.

On the **live** tab, **Payouts** shows a card instead of these buttons: "On-chain payouts: coming with Tachi exit support", with a link back to this demo page. That's intentional (see the talk track).

### C3. Shop checkout (WooCommerce-style round trip)

- **The demo shop is local-only.** There is no shop on Railway. It runs only while `docker compose -f docker-compose.demo.yml up --build` is running on this laptop. That starts its own local mock gateway on `:8080` plus the "Satoshi Beans" shop on `:4000`, with built-in demo keys.
- **Flow:**
  - Open http://localhost:4000 and click **Buy** on a coffee. The browser lands on the OpenTill checkout at `localhost:8080/pay/…`.
  - Click **Simulate payment**. The checkout turns **Paid**.
  - Click **Return to store →**. *Screen:* "✅ Thanks — payment confirmed!". The shop learned about the payment from a signed webhook, not from the browser.
- **The WooCommerce plugin itself:** there is no live WordPress. *Show code + screenshot only:* open `plugins/opentill-for-woocommerce/includes/class-wc-gateway-opentill.php` and the plugin's `README.md`.
  - The plugin creates the invoice server-to-server, redirects to the same hosted checkout, and moves the order to *Processing* on the signed webhook.
  - `npm run build:plugin` produces the installable zip.
- If Docker isn't running, skip C3 and show the plugin code only.

---

## D. Three-minute talk track (mapped to Bounty #11)

- **0:00 What it is.** OpenTill is a self-hosted Bitcoin payment gateway: one container. It issues invoices, gives customers a hosted checkout, and gives the merchant a dashboard. Settlement runs on the Tachi network.
- **0:20 Invoice generation.** *(B1–B2)* One click, or one API call, creates an invoice with its own fresh receive address: a new key per invoice, derived from the merchant's seed.
- **0:40 Real-time confirmation.** *(B3–B4)* I pay from a Tachi wallet. The checkout flips to Paid on its own: the gateway watches the ledger, and the page is pushed the change.
  - *Honest note:* the QR is a standard `bitcoin:` link, but these addresses receive on the **Tachi ledger**. Today you pay with Tachi tooling, here our `pay:tachi` script. A generic Bitcoin wallet would pay on-chain, and that payment wouldn't be detected.
- **1:05 Proof.** *(B5)* "View on Tachi" shows the payment as the ledger recorded it.
  - *Honest note:* it's the Tachi node's own JSON, because no ledger explorer exists yet. The public regtest explorer only shows Bitcoin L1.
- **1:20 Merchant dashboard + refunds.** *(B6–B7)* Refunds are real ledger transfers from the merchant's float. A refund only counts as done once the node accepts it **and** it commits, and here's that refund on the ledger.
- **1:45 Self-hosted / open-source deploy.** One Dockerfile, a `docker compose` demo, and a Railway runbook (`RAILWAY.md`). Both instances you just saw run on it. MIT-licensed: clone, set two secrets, run.
- **2:05 E-commerce plugin.** *(C3)* A WooCommerce plugin plus a tiny demo shop. The order is updated by HMAC-signed webhooks with retries, never by the browser.
- **2:25 Payouts / liquidity.** *(C2)* Cooperative withdrawal and the unilateral-exit escape hatch are fully built and live in demo mode.
  - On Tachi it's blocked on the protocol: moving received sats back to on-chain Bitcoin needs Tachi's VTXO exit, which isn't exposed yet. The live Payouts page says exactly that.
  - Meanwhile the funds stay self-custodial: only the merchant's seed can move them.
- **2:45 Honesty.** The regtest sats were minted by a self-signed deposit, which regtest allows. Mainnet needs Tachi's attested deposits. Everything unimplemented fails loudly instead of faking success.

---

## E. Likely judge questions

1. **"What's the path to mainnet?"** The settlement layer is a pluggable adapter. Signet should work as-is (`TACHI_NETWORK=signet`). Mainnet needs two things from Tachi that don't exist yet: attested deposits (no self-minting) and the VTXO exit for payouts. Nothing in the gateway, checkout, plugin or webhooks changes.
2. **"How are the keys secured?"**
   - One BIP-39 seed per instance, held only as a host secret (Railway variable) and in the merchant's password manager. Every invoice gets its own derived key.
   - The gateway refuses to boot if a used seed meets an empty state file, so addresses are never reused.
   - The merchant API key is env-only and compared in constant time. The browser keeps it only for the tab.
   - The public checkout uses an explicit field allowlist, so no order ids or webhook URLs leak.
3. **"Why polling and not websockets?"**
   - The gateway polls the Tachi node every 2 s with a height cursor. That's idempotent and survives restarts: if we're down, we pick up where we left off.
   - Customers' browsers *are* pushed, using server-sent events.
   - The SDK's websocket `watch()` is the next step. Known cost: polling grows with invoice history.
4. **"How are refunds funded?"**
   - From the merchant's **till**, a pre-funded key holding the float. A refund is a plain Tachi ledger transfer, recorded only when the node returns success and the transaction commits.
   - If no single key can cover it, the refund fails with a clear message. Nothing is half-done.
5. **"What happens if Tachi is down?"**
   - The gateway stays up, and dashboards and existing invoices keep working, but new payments can't be detected until the node is back. The poller then resumes from its cursor and nothing is missed.
   - Refunds fail loudly. A *fresh* boot refuses to start against an unreachable or wrong-chain node, by design.
6. **"Why not plain Lightning or on-chain?"** Tachi gives instant, cheap (1-sat fee) off-chain settlement with a Bitcoin-backed exit, without channel liquidity management. The adapter boundary means other rails can be added.
7. **"What about fiat prices?"** There's no price feed yet. The plugin uses a fixed sats-per-unit rate the merchant sets. It's listed in `GAPS.md`.
8. **"Is the WooCommerce plugin tested?"** It's lint-checked, with no WordPress test harness. The same API + webhook round trip is covered by automated tests (224) through the demo shop.

---

## F. Failure playbook

**Before anything else:** run `npm run preflight`. It tells you which piece is broken in about 2 seconds.

### F1. The live invoice doesn't confirm within 30 seconds

1. **Look at the terminal output from `pay:tachi`.**
   - **`code=0` … `committed=true`:** the money moved. Reload the checkout tab (`⌘R`). The live updates may have dropped, and a reload shows the true status. Also check the dashboard: Invoices → the row → *Payments*.
   - **An error such as `customer … has N sats, needs …`:** the customer wallet is empty. Switch to the demo flow (C1) and say "the regtest wallet ran dry". An engineer can top it up later.
   - **`code=` not 0, or the command crashed:** the payment did **not** go through. Running the same command **once** more is safe.
2. **Never pay the same invoice twice after a `committed=true`.** That would overpay it.
3. **Still pending after a reload:** say "the regtest node is slow right now". Move to the demo instance (C1), which shows the identical checkout behaviour, and come back to live at the end.

### F2. Tachi RPC is down (preflight: "Tachi RPC reachable … FAIL")

- **Do not restart or redeploy the live service.** A fresh boot refuses to start while the node is unreachable. The running one keeps serving pages.
- Present the live dashboard read-only: Overview, earlier invoices, the Payouts card. Run every *action* on the demo instance (sections C1–C2).
- Line to use: "The gateway is fine. The Tachi regtest node is down, and when it's back the gateway catches up on its own."

### F3. A dashboard logs you out (the API-key box reappears)

This happens if the tab was closed or reloaded into a new tab, or the key was mistyped. Repeat A3 for that tab: copy line 11 of `.env.railway-live` or `.env.railway-demo`, paste, and click **Unlock**. Keep the file off-screen while you do it.

### F4. A refund fails

- **"no single key can cover …":** the till is low. Preflight checks it is at least 10 000 sats. Say so, and show the earlier refunded invoice instead.
- **Address error:** you pasted something wrong. Click **Try again** and paste the customer address from the table at the top of this file.

### F5. Wifi fails

1. **Play the backup video** (keep it open in a player before going on stage).
2. If there is time and Docker was started in A1, the **local demo shop** (C3) works without internet: http://localhost:4000 and http://localhost:8080/dashboard.
   - The local dashboard key is `demo_api_key`. It's the public default from `docker-compose.demo.yml`, not a secret.
3. A phone hotspot is enough for everything else. Run `npm run preflight` once connected.

### F6. The demo instance shows 0 spendable

Someone ran the unilateral exit, or the demo service restarted (mock balances live in memory). Run C1 two or three times to refill it. **Don't redeploy the demo just before going on**, because that resets its balance.
