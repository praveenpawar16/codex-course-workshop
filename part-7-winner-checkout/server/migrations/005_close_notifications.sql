-- Idempotent per-recipient Close notifications. One row per (auction, recipient).
CREATE TABLE close_notifications (
  id uuid PRIMARY KEY,
  auction_id uuid NOT NULL REFERENCES auctions (id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('seller', 'winner')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  emitted_at timestamptz,
  dismissed_at timestamptz
);

CREATE UNIQUE INDEX close_notifications_auction_recipient_uidx
  ON close_notifications (auction_id, recipient_user_id);

CREATE INDEX close_notifications_recipient_undismissed_idx
  ON close_notifications (recipient_user_id, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX close_notifications_pending_emit_idx
  ON close_notifications (created_at)
  WHERE emitted_at IS NULL;
