import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';

import { artForCategory, CATEGORY_NAMES } from './categories.js';
import {
  dismissCloseNotification,
  listUndismissedCloseNotifications,
} from './notifyClose.js';
import {
  applyStripeWebhook,
  getOrCreatePurchase,
  loadPurchaseForAuction,
  purchaseVisibleTo,
  rememberCheckoutSession,
  resolveCheckoutSession,
  serializePurchase,
  unpaidPurchaseFromWinningAmount,
  type PurchaseView,
} from './purchases.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';

const MIN_INCREMENT_CENTS = 100;

export type PublishAuctionChanged = (auctionSlug: string) => void | Promise<void>;
export type RedisHealthCheck = () => Promise<boolean>;

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
  closed_at: Date | null;
  winner_id: string | null;
  winning_amount_cents: number | null;
  specifications: Array<[string, string]>;
  seller_id: string;
  seller_handle: string;
  seller_display_name: string;
  leading_bidder_id: string | null;
  leading_bidder_handle: string | null;
  leading_bidder_display_name: string | null;
  winner_handle: string | null;
  winner_display_name: string | null;
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
  publishAuctionChanged?: PublishAuctionChanged;
  checkRedis?: RedisHealthCheck;
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

function serializeAuction(row: AuctionRow, now: Date, purchase: PurchaseView | null = null) {
  const closingTime = new Date(row.closing_time);
  const closedAt = row.closed_at ? new Date(row.closed_at) : null;
  const closed = closedAt !== null;
  const outcome = !closed
    ? null
    : row.winner_id
      ? ('sold' as const)
      : ('unsold' as const);
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
    closed,
    closedAt: closedAt ? closedAt.toISOString() : null,
    outcome,
    winningAmountCents: row.winning_amount_cents,
    minimumBidCents: row.current_amount_cents + MIN_INCREMENT_CENTS,
    specifications: row.specifications ?? [],
    purchase,
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
    winner: row.winner_id
      ? {
          id: row.winner_id,
          handle: row.winner_handle!,
          displayName: row.winner_display_name!,
        }
      : null,
  };
}

async function purchaseViewForViewer(
  pool: pg.Pool | pg.PoolClient,
  row: AuctionRow,
  viewerId: string | null | undefined
): Promise<PurchaseView | null> {
  if (
    !purchaseVisibleTo({
      viewerId,
      sellerId: row.seller_id,
      winnerId: row.winner_id,
    })
  ) {
    return null;
  }
  if (!row.closed_at || !row.winner_id || row.winning_amount_cents == null) {
    return null;
  }
  const stored = await loadPurchaseForAuction(pool, row.id);
  if (stored) return serializePurchase(stored);
  return unpaidPurchaseFromWinningAmount(row.winning_amount_cents);
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
    a.closed_at, a.winner_id, a.winning_amount_cents,
    a.seller_id, seller.handle AS seller_handle, seller.display_name AS seller_display_name,
    a.leading_bidder_id,
    leader.handle AS leading_bidder_handle,
    leader.display_name AS leading_bidder_display_name,
    winner.handle AS winner_handle,
    winner.display_name AS winner_display_name
  FROM auctions a
  JOIN users seller ON seller.id = a.seller_id
  LEFT JOIN users leader ON leader.id = a.leading_bidder_id
  LEFT JOIN users winner ON winner.id = a.winner_id
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
  const publishAuctionChanged: PublishAuctionChanged =
    options.publishAuctionChanged ?? (async () => undefined);
  const checkRedis: RedisHealthCheck = options.checkRedis ?? (async () => true);
  const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : String(body);
    (request as { rawBody?: string }).rawBody = raw;
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/api/health', async (request, reply) => {
    let db: 'ok' | 'down' = 'down';
    let redis: 'ok' | 'down' = 'down';
    try {
      await pool.query('SELECT 1');
      db = 'ok';
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
    }
    try {
      redis = (await checkRedis()) ? 'ok' : 'down';
    } catch (error) {
      request.log.error({ err: error }, 'redis health check failed');
      redis = 'down';
    }
    if (db !== 'ok' || redis !== 'ok') {
      return reply.code(503).send({ ok: false, db, redis, requestId: request.id });
    }
    return { ok: true, db, redis, requestId: request.id };
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

  app.get<{ Params: { userId: string } }>(
    '/api/users/:userId/close-notifications',
    async (request, reply) => {
      const user = await pool.query<UserRow>('SELECT id FROM users WHERE id = $1', [
        request.params.userId,
      ]);
      if (!user.rows[0]) {
        return reply.code(404).send({ error: 'User not found' });
      }
      const rows = await listUndismissedCloseNotifications(pool, request.params.userId);
      return {
        notifications: rows.map((row) => ({
          ...row.payload,
          notificationId: row.id,
          id: row.id,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/close-notifications/:id/dismiss',
    async (request, reply) => {
      const body = z
        .object({ userId: z.string().uuid() })
        .safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid dismiss request' });
      }
      const dismissed = await dismissCloseNotification(
        pool,
        request.params.id,
        body.data.userId
      );
      if (!dismissed) {
        return reply.code(404).send({ error: 'Notification not found' });
      }
      return { ok: true };
    }
  );

  app.get('/api/auctions', async () => {
    const at = now();
    const result = await pool.query<AuctionRow>(
      `${auctionSelect} ORDER BY a.closing_time ASC`
    );
    // List payloads omit Purchase; payment details are role-gated on the detail route.
    return { auctions: result.rows.map((row) => serializeAuction(row, at, null)) };
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

  app.get<{ Params: { slug: string }; Querystring: { viewerId?: string } }>(
    '/api/auctions/:slug',
    async (request, reply) => {
      const viewerId =
        typeof request.query.viewerId === 'string' &&
        z.string().uuid().safeParse(request.query.viewerId).success
          ? request.query.viewerId
          : null;
      const result = await pool.query<AuctionRow>(
        `${auctionSelect} WHERE a.slug = $1`,
        [request.params.slug]
      );
      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ error: 'Auction not found' });
      }
      const bids = await loadBids(pool, row.id);
      const purchase = await purchaseViewForViewer(pool, row, viewerId);
      return { auction: serializeAuction(row, now(), purchase), bids };
    }
  );

  app.post<{ Params: { slug: string } }>(
    '/api/auctions/:slug/checkout',
    async (request, reply) => {
      const body = z.object({ userId: z.string().uuid() }).safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid checkout request' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{
          id: string;
          slug: string;
          title: string;
          closed_at: Date | null;
          winner_id: string | null;
          winning_amount_cents: number | null;
        }>(
          `SELECT id, slug, title, closed_at, winner_id, winning_amount_cents
           FROM auctions WHERE slug = $1 FOR UPDATE`,
          [request.params.slug]
        );
        const auction = locked.rows[0];
        if (!auction) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Auction not found' });
        }
        if (!auction.closed_at || !auction.winner_id || !auction.winning_amount_cents) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Checkout is only available after a sold close' });
        }
        if (auction.winner_id !== body.data.userId) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'Only the winner may start checkout' });
        }

        const purchase = await getOrCreatePurchase(client, {
          auctionId: auction.id,
          winnerId: auction.winner_id,
          amountCents: auction.winning_amount_cents,
        });

        if (purchase.status === 'paid') {
          await client.query('COMMIT');
          const row = (
            await pool.query<AuctionRow>(`${auctionSelect} WHERE a.id = $1`, [auction.id])
          ).rows[0]!;
          return {
            purchase: serializePurchase(purchase),
            checkoutUrl: null,
            auction: serializeAuction(row, now(), serializePurchase(purchase)),
          };
        }

        await client.query('COMMIT');

        let session: { id: string; url: string; recovered: boolean };
        try {
          session = await resolveCheckoutSession({
            purchase,
            title: auction.title,
            slug: auction.slug,
            pool,
          });
        } catch (error) {
          const statusCode =
            error && typeof error === 'object' && 'statusCode' in error
              ? Number((error as { statusCode: unknown }).statusCode)
              : 502;
          return reply
            .code(Number.isFinite(statusCode) ? statusCode : 502)
            .send({
              error: error instanceof Error ? error.message : 'Checkout unavailable',
            });
        }

        const rememberClient = await pool.connect();
        try {
          await rememberCheckoutSession(rememberClient, purchase.id, session.id);
        } finally {
          rememberClient.release();
        }

        const row = (
          await pool.query<AuctionRow>(`${auctionSelect} WHERE a.id = $1`, [auction.id])
        ).rows[0]!;
        const latestPurchase = await loadPurchaseForAuction(pool, auction.id);
        return {
          purchase: serializePurchase(latestPurchase ?? purchase),
          checkoutUrl: session.url,
          recovered: session.recovered,
          auction: serializeAuction(
            row,
            now(),
            latestPurchase ? serializePurchase(latestPurchase) : serializePurchase(purchase)
          ),
        };
      } catch (error) {
        await client.query('ROLLBACK');
        if (error && typeof error === 'object' && 'statusCode' in error) {
          return reply
            .code(Number((error as { statusCode: number }).statusCode))
            .send({ error: error instanceof Error ? error.message : 'Checkout failed' });
        }
        throw error;
      } finally {
        client.release();
      }
    }
  );

  app.post('/api/webhooks/stripe', async (request, reply) => {
    const rawBody = (request as { rawBody?: string }).rawBody ?? '';
    const signature =
      typeof request.headers['x-stripe-signature'] === 'string'
        ? request.headers['x-stripe-signature']
        : undefined;
    const result = await applyStripeWebhook(pool, rawBody, signature);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return { ok: true, purchase: result.purchase, replayed: result.replayed };
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
        closed_at: Date | null;
      }>(
        `SELECT id, seller_id, current_amount_cents, closing_time, closed_at
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
      // Closing time remains the authoritative bidding cutoff; closed_at is the durable outcome.
      const acceptedAt = now();
      if (
        auction.closed_at !== null ||
        new Date(auction.closing_time).getTime() <= acceptedAt.getTime()
      ) {
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

      // Fan-out only after commit; failure must not undo the accepted bid.
      try {
        await publishAuctionChanged(request.params.slug);
      } catch (error) {
        request.log.error({ err: error, slug: request.params.slug }, 'auction-changed publish failed');
      }

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
