import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';

import { artForCategory, CATEGORY_NAMES } from './categories.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_3';

const MIN_INCREMENT_CENTS = 100;

type UserRow = {
  id: string;
  handle: string;
  display_name: string;
};

type AuctionRow = {
  id: string;
  slug: string;
  title: string;
  kicker: string;
  category: string;
  art: string;
  description: string;
  condition: string;
  location: string;
  starting_price_cents: number;
  current_amount_cents: number;
  bid_count: number;
  closing_time: Date;
  specifications: Array<[string, string]>;
  seller_id: string;
  seller_handle: string;
  seller_display_name: string;
  leading_bidder_id: string | null;
  leading_bidder_handle: string | null;
  leading_bidder_display_name: string | null;
};

type BidRow = {
  id: string;
  amount_cents: number;
  created_at: Date;
  bidder_id: string;
  bidder_handle: string;
  bidder_display_name: string;
};

const createAuctionSchema = z.object({
  sellerId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  category: z.enum(CATEGORY_NAMES),
  description: z.string().trim().min(1).max(4000),
  condition: z.string().trim().min(1).max(120),
  location: z.string().trim().min(1).max(120),
  startingPriceCents: z.number().int().positive(),
  closingTime: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Closing time must be a valid timestamp'),
});

const placeBidSchema = z.object({
  bidderId: z.string().uuid(),
  amountCents: z.number().int().positive(),
});

export type AppClock = () => Date;

export type BuildAppOptions = {
  now?: AppClock;
};

function formatTimeLeft(closingTime: Date, now: Date): string {
  const ms = closingTime.getTime() - now.getTime();
  if (ms <= 0) return 'Ended';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

function serializeAuction(row: AuctionRow, now: Date) {
  const closingTime = new Date(row.closing_time);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kicker: row.kicker,
    category: row.category,
    art: row.art,
    description: row.description,
    condition: row.condition,
    location: row.location,
    startingPriceCents: row.starting_price_cents,
    currentAmountCents: row.current_amount_cents,
    bidCount: row.bid_count,
    closingTime: closingTime.toISOString(),
    timeLeft: formatTimeLeft(closingTime, now),
    ended: closingTime.getTime() <= now.getTime(),
    minimumBidCents: row.current_amount_cents + MIN_INCREMENT_CENTS,
    specifications: row.specifications ?? [],
    seller: {
      id: row.seller_id,
      handle: row.seller_handle,
      displayName: row.seller_display_name,
    },
    leadingBidder: row.leading_bidder_id
      ? {
          id: row.leading_bidder_id,
          handle: row.leading_bidder_handle,
          displayName: row.leading_bidder_display_name,
        }
      : null,
  };
}

function serializeBid(row: BidRow) {
  return {
    id: row.id,
    amountCents: row.amount_cents,
    createdAt: new Date(row.created_at).toISOString(),
    bidder: {
      id: row.bidder_id,
      handle: row.bidder_handle,
      displayName: row.bidder_display_name,
    },
  };
}

function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base.length > 0 ? base : 'auction';
}

const auctionSelect = `
  SELECT
    a.id, a.slug, a.title, a.kicker, a.category, a.art, a.description, a.condition, a.location,
    a.starting_price_cents, a.current_amount_cents, a.bid_count, a.closing_time, a.specifications,
    a.seller_id, seller.handle AS seller_handle, seller.display_name AS seller_display_name,
    a.leading_bidder_id,
    leader.handle AS leading_bidder_handle,
    leader.display_name AS leading_bidder_display_name
  FROM auctions a
  JOIN users seller ON seller.id = a.seller_id
  LEFT JOIN users leader ON leader.id = a.leading_bidder_id
`;

async function loadBids(pool: pg.Pool | pg.PoolClient, auctionId: string) {
  const result = await pool.query<BidRow>(
    `SELECT
      b.id, b.amount_cents, b.created_at,
      b.bidder_id, u.handle AS bidder_handle, u.display_name AS bidder_display_name
    FROM bids b
    JOIN users u ON u.id = b.bidder_id
    WHERE b.auction_id = $1
    ORDER BY b.created_at DESC, b.amount_cents DESC`,
    [auctionId]
  );
  return result.rows.map(serializeBid);
}

export function buildApp(options: BuildAppOptions = {}) {
  const now: AppClock = options.now ?? (() => new Date());
  const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/api/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, db: 'ok', requestId: request.id };
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
      return reply.code(503).send({ ok: false, db: 'down', requestId: request.id });
    }
  });

  app.get('/api/users', async () => {
    const result = await pool.query<UserRow>(
      'SELECT id, handle, display_name FROM users ORDER BY display_name ASC'
    );
    return {
      users: result.rows.map((row) => ({
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
      })),
    };
  });

  app.get('/api/auctions', async () => {
    const at = now();
    const result = await pool.query<AuctionRow>(
      `${auctionSelect} ORDER BY a.closing_time ASC`
    );
    return { auctions: result.rows.map((row) => serializeAuction(row, at)) };
  });

  app.post('/api/auctions', async (request, reply) => {
    const parsed = createAuctionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid auction',
        details: parsed.error.flatten(),
      });
    }

    const input = parsed.data;
    const art = artForCategory(input.category);
    if (!art) {
      return reply.code(400).send({ error: 'Unknown category' });
    }

    const at = now();
    const closingTime = new Date(input.closingTime);
    if (!(closingTime.getTime() > at.getTime())) {
      return reply.code(400).send({ error: 'Closing time must be in the future' });
    }

    const seller = await pool.query<UserRow>(
      'SELECT id, handle, display_name FROM users WHERE id = $1',
      [input.sellerId]
    );
    if (!seller.rows[0]) {
      return reply.code(400).send({ error: 'Seller not found' });
    }

    const id = randomUUID();
    let slug = slugifyTitle(input.title);
    const existing = await pool.query<{ slug: string }>(
      'SELECT slug FROM auctions WHERE slug = $1 OR slug LIKE $2',
      [slug, `${slug}-%`]
    );
    if (existing.rows.some((row) => row.slug === slug)) {
      slug = `${slug}-${id.slice(0, 8)}`;
    }

    await pool.query(
      `INSERT INTO auctions (
        id, slug, title, kicker, category, art, description, condition, location,
        starting_price_cents, current_amount_cents, bid_count, leading_bidder_id, seller_id,
        closing_time, specifications
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $10, 0, NULL, $11,
        $12, '[]'::jsonb
      )`,
      [
        id,
        slug,
        input.title,
        '',
        input.category,
        art,
        input.description,
        input.condition,
        input.location,
        input.startingPriceCents,
        input.sellerId,
        closingTime.toISOString(),
      ]
    );

    const created = await pool.query<AuctionRow>(`${auctionSelect} WHERE a.id = $1`, [id]);
    const row = created.rows[0];
    if (!row) {
      return reply.code(500).send({ error: 'Auction created but could not be loaded' });
    }

    return reply.code(201).send({ auction: serializeAuction(row, at), bids: [] });
  });

  app.get<{ Params: { slug: string } }>('/api/auctions/:slug', async (request, reply) => {
    const result = await pool.query<AuctionRow>(
      `${auctionSelect} WHERE a.slug = $1`,
      [request.params.slug]
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'Auction not found' });
    }
    const bids = await loadBids(pool, row.id);
    return { auction: serializeAuction(row, now()), bids };
  });

  app.post<{ Params: { slug: string } }>('/api/auctions/:slug/bids', async (request, reply) => {
    const parsed = placeBidSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid bid',
        details: parsed.error.flatten(),
      });
    }

    const { bidderId, amountCents } = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // BEGIN → lock auction row → read clock + latest price → validate → insert → COMMIT
      const locked = await client.query<{
        id: string;
        seller_id: string;
        current_amount_cents: number;
        closing_time: Date;
      }>(
        `SELECT id, seller_id, current_amount_cents, closing_time
         FROM auctions
         WHERE slug = $1
         FOR UPDATE`,
        [request.params.slug]
      );
      const auction = locked.rows[0];
      if (!auction) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Auction not found' });
      }

      // Single clock reading after the lock drives acceptance and bid timestamp.
      const acceptedAt = now();
      if (new Date(auction.closing_time).getTime() <= acceptedAt.getTime()) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'This auction has ended' });
      }

      if (auction.seller_id === bidderId) {
        await client.query('ROLLBACK');
        return reply.code(403).send({ error: 'Sellers cannot bid on their own auctions' });
      }

      const bidder = await client.query<UserRow>(
        'SELECT id, handle, display_name FROM users WHERE id = $1',
        [bidderId]
      );
      if (!bidder.rows[0]) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'Bidder not found' });
      }

      const minimumBidCents = auction.current_amount_cents + MIN_INCREMENT_CENTS;
      if (amountCents < minimumBidCents) {
        await client.query('ROLLBACK');
        const latest = await pool.query<AuctionRow>(`${auctionSelect} WHERE a.id = $1`, [auction.id]);
        const row = latest.rows[0];
        const bids = row ? await loadBids(pool, row.id) : [];
        return reply.code(400).send({
          error: `Bid must be at least $1.00 above the current amount (minimum ${minimumBidCents} cents)`,
          minimumBidCents,
          auction: row ? serializeAuction(row, acceptedAt) : undefined,
          bids,
        });
      }

      const bidId = randomUUID();
      await client.query(
        `INSERT INTO bids (id, auction_id, bidder_id, amount_cents, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [bidId, auction.id, bidderId, amountCents, acceptedAt.toISOString()]
      );
      await client.query(
        `UPDATE auctions
         SET current_amount_cents = $1,
             bid_count = bid_count + 1,
             leading_bidder_id = $2
         WHERE id = $3`,
        [amountCents, bidderId, auction.id]
      );

      await client.query('COMMIT');

      const updated = await pool.query<AuctionRow>(`${auctionSelect} WHERE a.id = $1`, [auction.id]);
      const row = updated.rows[0];
      if (!row) {
        return reply.code(500).send({ error: 'Bid saved but auction could not be reloaded' });
      }
      const bids = await loadBids(pool, row.id);
      return reply.code(201).send({ auction: serializeAuction(row, acceptedAt), bids });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.addHook('onClose', async () => pool.end());
  return app;
}
