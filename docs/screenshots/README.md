# Screenshots

Drop the submission screenshots here (referenced from the root README and the
demo video). Suggested shots, in order:

| File | Shot | How to reproduce |
| --- | --- | --- |
| `01-checkout-confirmed.png` | Checkout — the green "Paid" money screen | Pay an invoice on `/pay/<id>` (dev-simulate button) and catch the confirmed state. |
| `02-dashboard-overview.png` | Dashboard — overview with orange balance hero, stat cards, recent invoices | `/dashboard#/` with a few confirmed invoices. |
| `03-pos-flood.png` | POS — the full-orange "Paid" flood | `/dashboard#/pos`, create a charge, simulate payment, catch the flood (auto-resets after 8s). |
| `04-payouts-exit.png` | Payouts — unilateral exit with the live block countdown + amber banner | `/dashboard#/payouts`, start an exit, screenshot mid-timelock. |
| `05-demo-store.png` | Satoshi Beans demo store → hosted checkout | `docker compose -f docker-compose.demo.yml up`, `http://localhost:4000`. |
| `06-checkout-topup.png` *(optional)* | Checkout — green top-up state (underpaid before expiry) | Simulate a partial payment before expiry. |

PNG, 2× where possible. Keep filenames stable — the README links to them.
