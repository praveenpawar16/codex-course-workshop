CREATE TABLE bids (
  id uuid PRIMARY KEY,
  auction_id uuid NOT NULL REFERENCES auctions (id) ON DELETE CASCADE,
  bidder_id uuid NOT NULL REFERENCES users (id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bids_auction_id_created_at_idx ON bids (auction_id, created_at DESC);
