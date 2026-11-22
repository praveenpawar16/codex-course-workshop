import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export const AUCTION_CLOSED_EVENT = 'auction.closed';

export type CloseClock = () => Date;

export type ClosedAuctionResult = {
  auctionId: string;
  slug: string;
  sellerId: string;
  closedAt: string;
  outcome: 'sold' | 'unsold';
  winnerId: string | null;
  winningAmountCents: number | null;
  outboxId: string;
  payload: AuctionClosedPayload;
};

export type AuctionClosedPayload = {
  eventType: typeof AUCTION_CLOSED_EVENT;
  auctionId: string;
  auctionSlug: string;
  sellerId: string;
  closedAt: string;
  outcome: 'sold' | 'unsold';
  winnerId: string | null;
  winningAmountCents: number | null;
};

type ClaimedAuctionRow = {
  id: string;
  slug: string;
  seller_id: string;
  leading_bidder_id: string | null;
  current_amount_cents: number;
  bid_count: number;
  closing_time: Date;
};

/**
 * Claim due auctions with SKIP LOCKED, then record Closed + outbox in the same
 * transaction that holds the auction row lock (same lock bids use).
 */
export async function closeDueAuctions(
  pool: pg.Pool,
  options: { now?: CloseClock; limit?: number } = {}
): Promise<ClosedAuctionResult[]> {
  const now = options.now ?? (() => new Date());
  const limit = options.limit ?? 10;
  const at = now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const claimed = await client.query<ClaimedAuctionRow>(
      `SELECT id, slug, seller_id, leading_bidder_id, current_amount_cents, bid_count, closing_time
       FROM auctions
       WHERE closing_time <= $1
         AND closed_at IS NULL
       ORDER BY closing_time ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [at.toISOString(), limit]
    );

    const results: ClosedAuctionResult[] = [];

    for (const row of claimed.rows) {
      // Re-check deadline under the row lock (authoritative bidding cutoff).
      if (new Date(row.closing_time).getTime() > at.getTime()) {
        continue;
      }

      const sold = row.bid_count > 0 && row.leading_bidder_id !== null;
      const winnerId = sold ? row.leading_bidder_id : null;
      const winningAmountCents = sold ? row.current_amount_cents : null;
      const outcome: 'sold' | 'unsold' = sold ? 'sold' : 'unsold';
      const closedAt = at.toISOString();
      const outboxId = randomUUID();

      const updated = await client.query(
        `UPDATE auctions
         SET closed_at = $1,
             winner_id = $2,
             winning_amount_cents = $3
         WHERE id = $4
           AND closed_at IS NULL`,
        [closedAt, winnerId, winningAmountCents, row.id]
      );

      if (updated.rowCount !== 1) {
        continue;
      }

      const payload: AuctionClosedPayload = {
        eventType: AUCTION_CLOSED_EVENT,
        auctionId: row.id,
        auctionSlug: row.slug,
        sellerId: row.seller_id,
        closedAt,
        outcome,
        winnerId,
        winningAmountCents,
      };

      await client.query(
        `INSERT INTO auction_close_outbox (id, auction_id, event_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [outboxId, row.id, AUCTION_CLOSED_EVENT, JSON.stringify(payload)]
      );

      results.push({
        auctionId: row.id,
        slug: row.slug,
        sellerId: row.seller_id,
        closedAt,
        outcome,
        winnerId,
        winningAmountCents,
        outboxId,
        payload,
      });
    }

    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type UnpublishedOutboxRow = {
  id: string;
  auction_id: string;
  event_type: string;
  payload: AuctionClosedPayload;
  created_at: Date;
};

export async function listUnpublishedCloseOutbox(
  pool: pg.Pool,
  limit = 50
): Promise<UnpublishedOutboxRow[]> {
  const result = await pool.query<UnpublishedOutboxRow>(
    `SELECT id, auction_id, event_type, payload, created_at
     FROM auction_close_outbox
     WHERE published_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** Mark published only after the caller has broker confirmation. */
export async function markCloseOutboxPublished(
  pool: pg.Pool,
  outboxId: string,
  publishedAt: Date = new Date()
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE auction_close_outbox
     SET published_at = $2
     WHERE id = $1
       AND published_at IS NULL`,
    [outboxId, publishedAt.toISOString()]
  );
  return result.rowCount === 1;
}
