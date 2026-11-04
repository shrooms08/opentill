-- Settlement-layer transaction that created the payment's output, when the
-- adapter could tell (Tachi: mempool tx hash, or the committing block's tx).
-- Nullable and best-effort: the UI falls back to linking the invoice address.
ALTER TABLE payments ADD COLUMN tx_id TEXT;
