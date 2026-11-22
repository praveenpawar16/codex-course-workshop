CREATE TABLE users (
  id uuid PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL
);

CREATE TABLE auctions (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  kicker text NOT NULL DEFAULT '',
  category text NOT NULL,
  art text NOT NULL,
  description text NOT NULL,
  condition text NOT NULL,
  location text NOT NULL,
  starting_price_cents integer NOT NULL CHECK (starting_price_cents >= 0),
  current_amount_cents integer NOT NULL CHECK (current_amount_cents >= 0),
  bid_count integer NOT NULL DEFAULT 0 CHECK (bid_count >= 0),
  leading_bidder_id uuid REFERENCES users (id),
  seller_id uuid NOT NULL REFERENCES users (id),
  closing_time timestamptz NOT NULL,
  specifications jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auctions_closing_time_idx ON auctions (closing_time);
