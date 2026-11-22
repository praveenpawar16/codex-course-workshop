-- Durable close outcome on the auction row. closed_at NULL means not yet Closed.
ALTER TABLE auctions
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN winner_id uuid REFERENCES users (id),
  ADD COLUMN winning_amount_cents integer;

ALTER TABLE auctions
  ADD CONSTRAINT auctions_close_outcome_check CHECK (
    (
      closed_at IS NULL
      AND winner_id IS NULL
      AND winning_amount_cents IS NULL
    )
    OR (
      closed_at IS NOT NULL
      AND winner_id IS NULL
      AND winning_amount_cents IS NULL
    )
    OR (
      closed_at IS NOT NULL
      AND winner_id IS NOT NULL
      AND winning_amount_cents IS NOT NULL
      AND winning_amount_cents > 0
    )
  );

-- At most one durable close per auction (NULL is distinct in a unique index).
CREATE UNIQUE INDEX auctions_closed_once_idx
  ON auctions (id)
  WHERE closed_at IS NOT NULL;

CREATE INDEX auctions_due_to_close_idx
  ON auctions (closing_time)
  WHERE closed_at IS NULL;

-- One outbox event per closed auction; publish marker is separate from insert.
CREATE TABLE auction_close_outbox (
  id uuid PRIMARY KEY,
  auction_id uuid NOT NULL REFERENCES auctions (id) ON DELETE CASCADE,
  event_type text NOT NULL DEFAULT 'auction.closed',
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE UNIQUE INDEX auction_close_outbox_auction_id_uidx
  ON auction_close_outbox (auction_id);

CREATE UNIQUE INDEX auction_close_outbox_auction_event_uidx
  ON auction_close_outbox (auction_id, event_type);

CREATE INDEX auction_close_outbox_unpublished_idx
  ON auction_close_outbox (created_at)
  WHERE published_at IS NULL;
