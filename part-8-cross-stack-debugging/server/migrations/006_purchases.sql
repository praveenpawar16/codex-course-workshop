-- One Purchase per Closed Auction with a Winner. Amount is server-owned from the close outcome.
CREATE TABLE purchases (
  id uuid PRIMARY KEY,
  auction_id uuid NOT NULL UNIQUE REFERENCES auctions (id),
  winner_id uuid NOT NULL REFERENCES users (id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL CHECK (status IN ('unpaid', 'paid')),
  stripe_checkout_session_id text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchases_paid_consistency CHECK (
    (status = 'unpaid' AND paid_at IS NULL)
    OR (status = 'paid' AND paid_at IS NOT NULL)
  )
);

CREATE INDEX purchases_winner_id_idx ON purchases (winner_id);

-- Replay-safe webhook intake: each Stripe event id is applied at most once.
CREATE TABLE stripe_webhook_events (
  event_id uuid PRIMARY KEY,
  purchase_id uuid NOT NULL REFERENCES purchases (id),
  received_at timestamptz NOT NULL DEFAULT now()
);
