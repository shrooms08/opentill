-- Customer-facing "back to the store" link, rendered on terminal checkout
-- states. Public by nature (unlike webhook_url / order_id).
ALTER TABLE invoices ADD COLUMN return_url TEXT;
