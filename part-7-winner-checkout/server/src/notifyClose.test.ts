import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import type { AuctionClosedPayload } from './closeAuction.js';
import {
  deliverCloseNotifications,
  recipientsForClose,
} from './notifyClose.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';

const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
afterAll(async () => {
  await pool.end();
});

async function seedUsers() {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM users ORDER BY display_name ASC LIMIT 3'
  );
  return result.rows.map((row) => row.id);
}

async function insertClosedAuction(input: {
  sellerId: string;
  winnerId: string | null;
  winningAmountCents: number | null;
  outcome: 'sold' | 'unsold';
}) {
  const id = randomUUID();
  const slug = `notify-${id.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO auctions (
      id, slug, title, kicker, category, art, description, condition, location,
      starting_price_cents, current_amount_cents, bid_count, leading_bidder_id, seller_id,
      closing_time, closed_at, winner_id, winning_amount_cents, specifications
    ) VALUES (
      $1, $2, $3, '', 'Networking', 'switch', 'Notify test.', 'Used', 'Lab',
      10000, $4, $5, $6, $7,
      now() - interval '1 minute', now(), $6, $8, '[]'::jsonb
    )`,
    [
      id,
      slug,
      `Notify ${id.slice(0, 6)}`,
      input.winningAmountCents ?? 10000,
      input.winnerId ? 1 : 0,
      input.winnerId,
      input.sellerId,
      input.winningAmountCents,
    ]
  );
  const payload: AuctionClosedPayload = {
    eventType: 'auction.closed',
    auctionId: id,
    auctionSlug: slug,
    sellerId: input.sellerId,
    closedAt: new Date().toISOString(),
    outcome: input.outcome,
    winnerId: input.winnerId,
    winningAmountCents: input.winningAmountCents,
  };
  return { id, slug, payload };
}

describe('recipientsForClose', () => {
  it('selects seller and winner for sold auctions', () => {
    expect(
      recipientsForClose({
        eventType: 'auction.closed',
        auctionId: 'a',
        auctionSlug: 'lot',
        sellerId: 'seller',
        closedAt: new Date().toISOString(),
        outcome: 'sold',
        winnerId: 'winner',
        winningAmountCents: 10100,
      })
    ).toEqual([
      { userId: 'seller', role: 'seller' },
      { userId: 'winner', role: 'winner' },
    ]);
  });

  it('selects only the seller for unsold auctions', () => {
    expect(
      recipientsForClose({
        eventType: 'auction.closed',
        auctionId: 'a',
        auctionSlug: 'lot',
        sellerId: 'seller',
        closedAt: new Date().toISOString(),
        outcome: 'unsold',
        winnerId: null,
        winningAmountCents: null,
      })
    ).toEqual([{ userId: 'seller', role: 'seller' }]);
  });
});

describe('deliverCloseNotifications', () => {
  it('emits seller and winner once for a sold close', async () => {
    const [sellerId, winnerId] = await seedUsers();
    const { payload } = await insertClosedAuction({
      sellerId: sellerId!,
      winnerId: winnerId!,
      winningAmountCents: 15100,
      outcome: 'sold',
    });

    const emitted: string[] = [];
    const first = await deliverCloseNotifications(pool, payload, async (notification) => {
      emitted.push(`${notification.role}:${notification.recipientUserId}`);
    });

    expect(first.recipients).toHaveLength(2);
    expect(first.emitted).toHaveLength(2);
    expect(emitted.sort()).toEqual(
      [`seller:${sellerId}`, `winner:${winnerId}`].sort()
    );

    const rows = await pool.query(
      `SELECT recipient_user_id, role FROM close_notifications WHERE auction_id = $1 ORDER BY role`,
      [payload.auctionId]
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('emits only the seller for unsold', async () => {
    const [sellerId] = await seedUsers();
    const { payload } = await insertClosedAuction({
      sellerId: sellerId!,
      winnerId: null,
      winningAmountCents: null,
      outcome: 'unsold',
    });

    const roles: string[] = [];
    const result = await deliverCloseNotifications(pool, payload, async (notification) => {
      roles.push(notification.role);
    });

    expect(result.recipients).toEqual([{ userId: sellerId, role: 'seller' }]);
    expect(result.emitted).toHaveLength(1);
    expect(roles).toEqual(['seller']);
  });

  it('handles redelivery without duplicate emits or rows', async () => {
    const [sellerId, winnerId] = await seedUsers();
    const { payload } = await insertClosedAuction({
      sellerId: sellerId!,
      winnerId: winnerId!,
      winningAmountCents: 12100,
      outcome: 'sold',
    });

    const emitted: string[] = [];
    const emit = async (notification: { notificationId: string }) => {
      emitted.push(notification.notificationId);
    };

    const first = await deliverCloseNotifications(pool, payload, emit);
    expect(first.emitted).toHaveLength(2);

    const second = await deliverCloseNotifications(pool, payload, emit);
    expect(second.emitted).toHaveLength(0);
    expect(emitted).toHaveLength(2);

    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM close_notifications WHERE auction_id = $1`,
      [payload.auctionId]
    );
    expect(count.rows[0]?.count).toBe(2);
  });
});
