-- Invoices. All sat amounts are TEXT so bigints survive a round trip.
CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  amount_sats       TEXT NOT NULL,
  amount_paid_sats  TEXT NOT NULL DEFAULT '0',
  shortfall_sats    TEXT,
  address           TEXT NOT NULL UNIQUE,
  memo              TEXT,
  order_id          TEXT,
  webhook_url       TEXT,
  refund_address    TEXT,
  refund_tx_id      TEXT,
  refund_error      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_status_created ON invoices (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_expiry ON invoices (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices (order_id);

-- Payments observed on the settlement layer. payment_id is unique so replaying
-- the same poll batch is a no-op.
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL UNIQUE,
  invoice_id    TEXT REFERENCES invoices (id),
  address       TEXT NOT NULL,
  amount_sats   TEXT NOT NULL,
  status        TEXT NOT NULL,
  late_payment  INTEGER NOT NULL DEFAULT 0,
  observed_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);

-- Outbound webhook attempts. The body is frozen at enqueue time so the
-- signature stays stable across retries.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES invoices (id),
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

CREATE INDEX IF NOT EXISTS idx_webhooks_due ON webhook_deliveries (status, next_attempt_at);

-- Single-row table holding the settlement poll cursor.
CREATE TABLE IF NOT EXISTS adapter_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  cursor      TEXT,
  updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO adapter_state (id, cursor, updated_at) VALUES (1, NULL, 0);
