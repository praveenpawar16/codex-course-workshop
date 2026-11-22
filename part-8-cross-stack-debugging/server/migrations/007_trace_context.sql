-- Persist W3C trace context so the Winning Bid can anchor Close → notify → Checkout → Paid.
ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS trace_context text;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS trace_context text;
