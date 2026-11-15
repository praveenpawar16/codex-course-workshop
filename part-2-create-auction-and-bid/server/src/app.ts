import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';

import { artForCategory, CATEGORY_NAMES } from './categories.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_2';

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

function formatTimeLeft(closingTime: Date, now = new Date()): string {
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

function serializeAuction(row: AuctionRow) {
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
    timeLeft: formatTimeLeft(closingTime),
    ended: closingTime.getTime() <= Date.now(),
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

export function buildApp() {
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
    const result = await pool.query<AuctionRow>(
      `${auctionSelect} ORDER BY a.closing_time ASC`
    );
    return { auctions: result.rows.map(serializeAuction) };
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

    const closingTime = new Date(input.closingTime);
    if (!(closingTime.getTime() > Date.now())) {
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

    return reply.code(201).send({ auction: serializeAuction(row) });
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
    return { auction: serializeAuction(row) };
  });

  app.addHook('onClose', async () => pool.end());
  return app;
}
