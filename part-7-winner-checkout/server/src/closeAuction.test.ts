import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import {
  AUCTION_CLOSED_EVENT,
  closeDueAuctions,
  listUnpublishedCloseOutbox,
  markCloseOutboxPublished,
} from './closeAuction.js';
import { publishUnpublishedOutbox } from './closeWorker.js';
import type { RabbitPublisher } from './rabbitmq.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';

const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
afterAll(async () => {
  await pool.end();
});

async function seedUsers() {
  const app = buildApp({ checkRedis: async () => true });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/users' });
    return (response.json() as { users: Array<{ id: string }> }).users;
  } finally {
    await app.close();
  }
}

async function insertAuction(input: {
  sellerId: string;
  title: string;
  closingTime: Date;
  currentAmountCents?: number;
  bidCount?: number;
  leadingBidderId?: string | null;
}) {
  const id = randomUUID();
  const slug = `close-test-${id.slice(0, 8)}`;
  const amount = input.currentAmountCents ?? 10000;
  await pool.query(
    `INSERT INTO auctions (
      id, slug, title, kicker, category, art, description, condition, location,
      starting_price_cents, current_amount_cents, bid_count, leading_bidder_id, seller_id,
      closing_time, specifications
    ) VALUES (
      $1, $2, $3, '', 'Networking', 'switch', 'Close test lot.', 'Used', 'Test Lab',
      $4, $4, $5, $6, $7, $8, '[]'::jsonb
    )`,
    [
      id,
      slug,
      input.title,
      amount,
      input.bidCount ?? 0,
      input.leadingBidderId ?? null,
      input.sellerId,
      input.closingTime.toISOString(),
    ]
  );
  return { id, slug };
}

describe('closeDueAuctions', () => {
  it('does not close auctions that are still before the deadline', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const { id } = await insertAuction({
      sellerId,
      title: `Not Due ${Date.now()}`,
      closingTime: future,
    });

    const closed = await closeDueAuctions(pool, { now: () => new Date(), limit: 50 });
    expect(closed.some((row) => row.auctionId === id)).toBe(false);

    const row = await pool.query<{ closed_at: Date | null }>(
      'SELECT closed_at FROM auctions WHERE id = $1',
      [id]
    );
    expect(row.rows[0]?.closed_at).toBeNull();
  });

  it('records sold outcome, winner, and a single outbox event', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const winnerId = users[1]!.id;
    const past = new Date(Date.now() - 5_000);
    const { id, slug } = await insertAuction({
      sellerId,
      title: `Sold Close ${Date.now()}`,
      closingTime: past,
      currentAmountCents: 15100,
      bidCount: 2,
      leadingBidderId: winnerId,
    });

    const closed = await closeDueAuctions(pool, { now: () => new Date(past.getTime() + 1_000) });
    const match = closed.find((row) => row.auctionId === id);
    expect(match).toMatchObject({
      slug,
      outcome: 'sold',
      winnerId,
      winningAmountCents: 15100,
      sellerId,
    });

    const auction = await pool.query(
      `SELECT closed_at, winner_id, winning_amount_cents FROM auctions WHERE id = $1`,
      [id]
    );
    expect(auction.rows[0]).toMatchObject({
      winner_id: winnerId,
      winning_amount_cents: 15100,
    });
    expect(auction.rows[0]?.closed_at).toBeTruthy();

    const outbox = await pool.query(
      `SELECT event_type, payload FROM auction_close_outbox WHERE auction_id = $1`,
      [id]
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({
      event_type: AUCTION_CLOSED_EVENT,
      payload: expect.objectContaining({
        outcome: 'sold',
        winnerId,
        winningAmountCents: 15100,
        auctionSlug: slug,
      }),
    });
  });

  it('records unsold outcome with no winner when there were no bids', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const past = new Date(Date.now() - 5_000);
    const { id } = await insertAuction({
      sellerId,
      title: `Unsold Close ${Date.now()}`,
      closingTime: past,
      bidCount: 0,
      leadingBidderId: null,
    });

    const closed = await closeDueAuctions(pool, { now: () => new Date() });
    const match = closed.find((row) => row.auctionId === id);
    expect(match).toMatchObject({
      outcome: 'unsold',
      winnerId: null,
      winningAmountCents: null,
      sellerId,
    });

    const auction = await pool.query(
      `SELECT winner_id, winning_amount_cents FROM auctions WHERE id = $1`,
      [id]
    );
    expect(auction.rows[0]).toMatchObject({
      winner_id: null,
      winning_amount_cents: null,
    });
  });

  it('only one concurrent closer records the outcome and outbox row', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const winnerId = users[2]!.id;
    const past = new Date(Date.now() - 2_000);
    const { id } = await insertAuction({
      sellerId,
      title: `Concurrent Close ${Date.now()}`,
      closingTime: past,
      currentAmountCents: 12000,
      bidCount: 1,
      leadingBidderId: winnerId,
    });

    const now = () => new Date();
    const [a, b, c] = await Promise.all([
      closeDueAuctions(pool, { now, limit: 50 }),
      closeDueAuctions(pool, { now, limit: 50 }),
      closeDueAuctions(pool, { now, limit: 50 }),
    ]);

    const wins = [a, b, c].flat().filter((row) => row.auctionId === id);
    expect(wins).toHaveLength(1);

    const outbox = await pool.query(
      `SELECT count(*)::int AS count FROM auction_close_outbox WHERE auction_id = $1`,
      [id]
    );
    expect(outbox.rows[0]?.count).toBe(1);

    const duplicate = await closeDueAuctions(pool, { now, limit: 50 });
    expect(duplicate.some((row) => row.auctionId === id)).toBe(false);
  });

  it('coordinates with an in-flight auction-row bid lock via SKIP LOCKED', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const winnerId = users[1]!.id;
    // Still open at claim time for the bid lock holder; we force closing_time into the past
    // while the lock is held so the closer would want it, then SKIP LOCKED must wait/skip.
    const closingSoon = new Date(Date.now() + 60_000);
    const { id, slug } = await insertAuction({
      sellerId,
      title: `Lock Coord ${Date.now()}`,
      closingTime: closingSoon,
      currentAmountCents: 10000,
      bidCount: 1,
      leadingBidderId: winnerId,
    });

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
      await holder.query(`UPDATE auctions SET closing_time = now() - interval '1 second' WHERE id = $1`, [
        id,
      ]);

      const skipped = await closeDueAuctions(pool, { now: () => new Date(), limit: 50 });
      expect(skipped.some((row) => row.auctionId === id)).toBe(false);

      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    const closed = await closeDueAuctions(pool, { now: () => new Date(), limit: 50 });
    expect(closed.some((row) => row.auctionId === id && row.slug === slug)).toBe(true);
  });

  it('rejects a second outbox insert for the same auction via uniqueness', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const past = new Date(Date.now() - 1_000);
    const { id } = await insertAuction({
      sellerId,
      title: `Dup Outbox ${Date.now()}`,
      closingTime: past,
    });

    await closeDueAuctions(pool, { now: () => new Date() });
    await expect(
      pool.query(
        `INSERT INTO auction_close_outbox (id, auction_id, event_type, payload)
         VALUES ($1, $2, $3, '{}'::jsonb)`,
        [randomUUID(), id, AUCTION_CLOSED_EVENT]
      )
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describe('outbox publish marking', () => {
  it('marks published only after broker confirmation and is idempotent on repeat', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const past = new Date(Date.now() - 1_000);
    const { id } = await insertAuction({
      sellerId,
      title: `Publish Mark ${Date.now()}`,
      closingTime: past,
    });

    await closeDueAuctions(pool, { now: () => new Date() });
    const unpublished = await listUnpublishedCloseOutbox(pool, 100);
    const row = unpublished.find((item) => item.auction_id === id);
    expect(row).toBeTruthy();

    const publishedPayloads: unknown[] = [];
    const publisher: RabbitPublisher = {
      async publishAuctionClosed(payload) {
        publishedPayloads.push(payload);
      },
      async close() {
        return;
      },
    };

    const first = await publishUnpublishedOutbox(pool, publisher, 100);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(publishedPayloads.some((payload) => (payload as { auctionId: string }).auctionId === id)).toBe(
      true
    );

    const after = await listUnpublishedCloseOutbox(pool, 100);
    expect(after.some((item) => item.auction_id === id)).toBe(false);

    const beforeCount = publishedPayloads.length;
    const second = await publishUnpublishedOutbox(pool, publisher, 100);
    expect(second).toBe(0);
    expect(publishedPayloads).toHaveLength(beforeCount);

    const markedAgain = await markCloseOutboxPublished(pool, row!.id);
    expect(markedAgain).toBe(false);
  });

  it('does not mark published when broker publish fails', async () => {
    const users = await seedUsers();
    const sellerId = users[0]!.id;
    const past = new Date(Date.now() - 1_000);
    const { id } = await insertAuction({
      sellerId,
      title: `Publish Fail ${Date.now()}`,
      closingTime: past,
    });

    await closeDueAuctions(pool, { now: () => new Date() });
    // Isolate this row so a failing publisher cannot trip on older unpublished events.
    await pool.query(
      `UPDATE auction_close_outbox
       SET published_at = now()
       WHERE published_at IS NULL
         AND auction_id <> $1`,
      [id]
    );

    const publisher: RabbitPublisher = {
      async publishAuctionClosed() {
        throw new Error('broker nack');
      },
      async close() {
        return;
      },
    };

    await expect(publishUnpublishedOutbox(pool, publisher, 100)).rejects.toThrow(/broker nack/);

    const still = await listUnpublishedCloseOutbox(pool, 100);
    expect(still.some((item) => item.auction_id === id)).toBe(true);
  });
});

describe('API exposes Closed vs Ended', () => {
  it('returns closed outcome fields after the worker records the close', async () => {
    const app = buildApp({ checkRedis: async () => true });
    try {
      const usersResponse = await app.inject({ method: 'GET', url: '/api/users' });
      const users = (usersResponse.json() as { users: Array<{ id: string }> }).users;
      const sellerId = users[0]!.id;
      const winnerId = users[1]!.id;
      const past = new Date(Date.now() - 2_000);
      const { slug } = await insertAuction({
        sellerId,
        title: `API Closed ${Date.now()}`,
        closingTime: past,
        currentAmountCents: 13000,
        bidCount: 1,
        leadingBidderId: winnerId,
      });

      const before = await app.inject({ method: 'GET', url: `/api/auctions/${slug}` });
      expect(before.json()).toMatchObject({
        auction: { ended: true, closed: false, outcome: null, winner: null },
      });

      await closeDueAuctions(pool, { now: () => new Date() });

      const after = await app.inject({ method: 'GET', url: `/api/auctions/${slug}` });
      expect(after.json()).toMatchObject({
        auction: {
          ended: true,
          closed: true,
          outcome: 'sold',
          winningAmountCents: 13000,
          winner: { id: winnerId },
        },
      });
    } finally {
      await app.close();
    }
  });
});
