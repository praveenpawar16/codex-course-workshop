import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type pg from 'pg';

import { createDb } from './db/client.js';
import { auctionCloseOutbox, auctions } from './db/schema.js';

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
  const db = createDb(pool);

  return db.transaction(async (tx) => {
    const claimed = await tx
      .select({
        id: auctions.id,
        slug: auctions.slug,
        sellerId: auctions.sellerId,
        leadingBidderId: auctions.leadingBidderId,
        currentAmountCents: auctions.currentAmountCents,
        bidCount: auctions.bidCount,
        closingTime: auctions.closingTime,
      })
      .from(auctions)
      .where(and(lte(auctions.closingTime, at), isNull(auctions.closedAt)))
      .orderBy(asc(auctions.closingTime))
      .limit(limit)
      .for('update', { skipLocked: true });

    const results: ClosedAuctionResult[] = [];

    for (const row of claimed) {
      if (row.closingTime.getTime() > at.getTime()) {
        continue;
      }

      const sold = row.bidCount > 0 && row.leadingBidderId !== null;
      const winnerId = sold ? row.leadingBidderId : null;
      const winningAmountCents = sold ? row.currentAmountCents : null;
      const outcome: 'sold' | 'unsold' = sold ? 'sold' : 'unsold';
      const closedAt = at;
      const outboxId = randomUUID();

      const updated = await tx
        .update(auctions)
        .set({
          closedAt,
          winnerId,
          winningAmountCents,
        })
        .where(and(eq(auctions.id, row.id), isNull(auctions.closedAt)))
        .returning({ id: auctions.id });

      if (updated.length !== 1) {
        continue;
      }

      const payload: AuctionClosedPayload = {
        eventType: AUCTION_CLOSED_EVENT,
        auctionId: row.id,
        auctionSlug: row.slug,
        sellerId: row.sellerId,
        closedAt: closedAt.toISOString(),
        outcome,
        winnerId,
        winningAmountCents,
      };

      await tx.insert(auctionCloseOutbox).values({
        id: outboxId,
        auctionId: row.id,
        eventType: AUCTION_CLOSED_EVENT,
        payload,
      });

      results.push({
        auctionId: row.id,
        slug: row.slug,
        sellerId: row.sellerId,
        closedAt: closedAt.toISOString(),
        outcome,
        winnerId,
        winningAmountCents,
        outboxId,
        payload,
      });
    }

    return results;
  });
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
  const db = createDb(pool);
  const rows = await db
    .select({
      id: auctionCloseOutbox.id,
      auctionId: auctionCloseOutbox.auctionId,
      eventType: auctionCloseOutbox.eventType,
      payload: auctionCloseOutbox.payload,
      createdAt: auctionCloseOutbox.createdAt,
    })
    .from(auctionCloseOutbox)
    .where(isNull(auctionCloseOutbox.publishedAt))
    .orderBy(asc(auctionCloseOutbox.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    auction_id: row.auctionId,
    event_type: row.eventType,
    payload: row.payload as AuctionClosedPayload,
    created_at: row.createdAt,
  }));
}

/** Mark published only after the caller has broker confirmation. */
export async function markCloseOutboxPublished(
  pool: pg.Pool,
  outboxId: string,
  publishedAt: Date = new Date()
): Promise<boolean> {
  const db = createDb(pool);
  const updated = await db
    .update(auctionCloseOutbox)
    .set({ publishedAt })
    .where(and(eq(auctionCloseOutbox.id, outboxId), isNull(auctionCloseOutbox.publishedAt)))
    .returning({ id: auctionCloseOutbox.id });
  return updated.length === 1;
}
