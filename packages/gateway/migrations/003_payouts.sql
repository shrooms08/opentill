-- Merchant withdrawals. Sats as TEXT, same conventions as invoices/payments.
CREATE TABLE IF NOT EXISTS payouts (
  id                          TEXT PRIMARY KEY,           -- gateway id (po_...)
  payout_id                   TEXT NOT NULL UNIQUE,       -- adapter id
  kind                        TEXT NOT NULL,              -- cooperative | exit
  to_address                  TEXT NOT NULL,
  amount_sats                 TEXT NOT NULL,
  status                      TEXT NOT NULL,              -- initiated | broadcasting | waiting_timelock | settled | failed
  timelock_blocks_remaining   INTEGER,
  tx_id                       TEXT,
  error                       TEXT,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  settled_at                  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payouts_created ON payouts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_kind_status ON payouts (kind, status);

-- Payout webhooks reuse the delivery machinery, so a delivery now belongs to
-- either an invoice or a payout. SQLite can't relax NOT NULL in place;
-- rebuild the table keeping every existing row.
CREATE TABLE webhook_deliveries_new (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT REFERENCES invoices (id),
  payout_id        TEXT REFERENCES payouts (id),
  url              TEXT NOT NULL,
  body             TEXT NOT NULL,
  signature        TEXT NOT NULL,
  status           TEXT NOT NULL,               -- pending | delivered | failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_status_code INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

INSERT INTO webhook_deliveries_new
  (id, invoice_id, payout_id, url, body, signature, status, attempts,
   next_attempt_at, last_status_code, last_error, created_at, updated_at)
SELECT
  id, invoice_id, NULL, url, body, signature, status, attempts,
  next_attempt_at, last_status_code, last_error, created_at, updated_at
FROM webhook_deliveries;

DROP TABLE webhook_deliveries;
ALTER TABLE webhook_deliveries_new RENAME TO webhook_deliveries;

CREATE INDEX IF NOT EXISTS idx_webhooks_due ON webhook_deliveries (status, next_attempt_at);
