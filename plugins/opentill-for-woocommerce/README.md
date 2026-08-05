# OpenTill for WooCommerce

Makes your self-hosted [OpenTill](../../README.md) gateway a WooCommerce payment method. Deliberately small: three PHP files + one build-free JS file, no Composer, no build step.

Works on **both** WooCommerce checkouts: the classic shortcode checkout and the default **block-based** Cart & Checkout (WooCommerce Blocks).

## How it works

1. At checkout the customer picks "Bitcoin (OpenTill)".
2. The plugin creates an invoice on **your** gateway (`POST /api/invoices`, server-to-server with your API key) and redirects the customer to OpenTill's hosted checkout page (`/pay/<invoiceId>`) — QR code, live status, the works.
3. Order state follows the gateway's **signed webhooks**, never the customer's browser: `confirmed` → order paid, `expired` → cancelled, `refunded` → refunded. Re-delivered webhooks are idempotent.
4. The checkout page shows a "Return to store" button back to the WooCommerce order-received page.

### Block checkout support

WooCommerce's default checkout is block-based, and payment methods must register a client-side integration to appear there — a gateway registered only via the classic `woocommerce_payment_gateways` filter is **invisible** on block checkout. This plugin ships that integration:

- `includes/class-wc-gateway-opentill-blocks.php` — a `AbstractPaymentMethodType` registered on `woocommerce_blocks_payment_method_type_registration` (guarded so it no-ops on WooCommerce builds without the Blocks package).
- `assets/js/blocks.js` — plain browser JS (no build step) that calls `wc.wcBlocksRegistry.registerPaymentMethod`, taking the title/description from the same settings the classic checkout uses.

All money logic stays in the classic gateway's `process_payment` (Blocks calls it under the hood), so invoice creation, redirect, and webhooks are identical on both checkouts. Classic checkout is unchanged.

## Install

1. Zip the plugin (`npm run build:plugin` in the OpenTill repo produces `dist/opentill-for-woocommerce.zip`) or copy `plugins/opentill-for-woocommerce/` into `wp-content/plugins/`.
2. Activate **OpenTill for WooCommerce** in WP Admin → Plugins (WooCommerce must be active).
3. WooCommerce → Settings → Payments → **OpenTill (Bitcoin)** → Manage.

## Settings

| Setting | What it is |
| --- | --- |
| Gateway URL | Base URL your **WP server** uses to reach the gateway for server-to-server API calls, e.g. `https://pay.example.com`. |
| Public checkout URL *(optional)* | Base URL the **customer's browser** is redirected to for the hosted checkout. Blank = reuse Gateway URL. |
| API key | `OPENTILL_API_KEY` from the gateway's `.env`. |
| Webhook secret | `OPENTILL_WEBHOOK_SECRET` from the gateway's `.env`. |
| Webhook base URL *(optional)* | Base URL the **gateway** uses to reach WordPress when building the webhook target. Blank = this site's home URL. |
| Sats per currency unit | Fixed conversion rate: order total × rate = sats. |
| Title / Description | What the customer sees at checkout (both classic and block). |

**One host or three?** In a simple deployment the gateway, the browser, and WordPress all agree on one URL — set **Gateway URL** and leave the two optional fields blank; behavior is exactly as before. The split fields exist because those three audiences can legitimately differ (containerized setups especially): the WP server, the customer's browser, and the gateway container may each reach a host by a different name.

**Webhook URL format:** the plugin registers `{base}/?wc-api=opentill` (with pretty permalinks: `{base}/wc-api/opentill`), where `{base}` is the **Webhook base URL** if set, otherwise the site's home URL. It is passed on every invoice — no manual webhook configuration on the gateway side.

### Docker testing recipe

Gateway in a container, WordPress on the host (or another container), browser on the host:

| Setting | Value |
| --- | --- |
| Gateway URL | `http://host.docker.internal:8080` (WP server → gateway container) |
| Public checkout URL | `http://localhost:8080` (browser → gateway, published port) |
| Webhook base URL | `http://host.docker.internal:8081` (gateway container → WordPress) |

Here WordPress listens on host port `8081`; that port **must be reachable from the gateway container** (`host.docker.internal` resolves the host from inside the container on Docker Desktop). Adjust hostnames/ports to your compose network.

## Limitations (deliberate, v0.1)

- **No live BTC/fiat conversion.** The sats-per-unit rate is a fixed number you set. Price drift is your responsibility; simplest is pricing products in sats (rate = 1) or pinning a rate you update manually.
- **Single currency** — whatever your WooCommerce currency is, times the fixed rate.
- **Refunds are initiated from the OpenTill dashboard**, not from WP admin. The order flips to "refunded" via webhook when you do.
- Underpaid/late-payment edge cases surface as order notes; resolve them in the OpenTill dashboard.

## Verifying the code

```sh
php -l opentill-for-woocommerce.php
php -l includes/class-wc-gateway-opentill.php
php -l includes/class-wc-gateway-opentill-blocks.php
node --check assets/js/blocks.js
```

should print three "No syntax errors detected" lines and no JS error. There is no PHP/WordPress test suite: the honest coverage statement is lint plus the HMAC scheme and webhook payloads being contract-tested on the gateway side (`packages/gateway/test/`). Block-checkout rendering and the split-URL redirect/webhook wiring need a live WordPress + WooCommerce to exercise end-to-end.
