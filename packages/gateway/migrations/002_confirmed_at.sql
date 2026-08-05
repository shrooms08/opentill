-- When the invoice first reached `confirmed` (unix ms). Set once and kept
-- through refund_pending -> confirmed reverts; drives the dashboard's 24h
-- revenue window without guessing from updated_at.
ALTER TABLE invoices ADD COLUMN confirmed_at INTEGER;
