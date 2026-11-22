import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, like, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';

import { artForCategory, CATEGORY_NAMES } from './categories.js';
import { createDb } from './db/client.js';
import { auctions, bids, users } from './db/schema.js';
import {
  dismissCloseNotification,
  listUndismissedCloseNotifications,
} from './notifyClose.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_6';

const MIN_INCREMENT_CENTS = 100;

export type PublishAuctionChanged = (auctionSlug: string) => void | Promise<void>;
export type RedisHealthCheck = () => Promise<boolean>;

type AuctionView = {
  id: string;
  slug: string;
  title: string;
  kicker: string;
  category: string;
  art: string;
  description: string;
  condition: string;
  location: string;
  startingPriceCents: number;
  currentAmountCents: number;
  bidCount: number;
  closingTime: Date;
  closedAt: Date | null;
  winnerId: string | null;
  winningAmountCents: number | null;
  specifications: Array<[string, string]>;
  sellerId: string;
  sellerHandle: string;
  sellerDisplayName: string;
  leadingBidderId: string | null;
  leadingBidderHandle: string | null;
  leadingBidderDisplayName: string | null;
  winnerHandle: string | null;
  winnerDisplayName: string | null;
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

function serializeAuction(row: AuctionView, now: Date) {
  const closingTime = new Date(row.closingTime);
  const closedAt = row.closedAt ? new Date(row.closedAt) : null;
  const closed = closedAt !== null;
  const outcome = !closed ? null : row.winnerId ? ('sold' as const) : ('unsold' as const);
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
    startingPriceCents: row.startingPriceCents,
    currentAmountCents: row.currentAmountCents,
    bidCount: row.bidCount,
    closingTime: closingTime.toISOString(),
    timeLeft: formatTimeLeft(closingTime, now),
    ended: closingTime.getTime() <= now.getTime(),
    closed,
    closedAt: closedAt ? closedAt.toISOString() : null,
    outcome,
    winningAmountCents: row.winningAmountCents,
    minimumBidCents: row.currentAmountCents + MIN_INCREMENT_CENTS,
    specifications: row.specifications ?? [],
    seller: {
      id: row.sellerId,
      handle: row.sellerHandle,
      displayName: row.sellerDisplayName,
    },
    leadingBidder: row.leadingBidderId
      ? {
          id: row.leadingBidderId,
          handle: row.leadingBidderHandle!,
          displayName: row.leadingBidderDisplayName!,
        }
      : null,
    winner: row.winnerId
      ? {
          id: row.winnerId,
          handle: row.winnerHandle!,
          displayName: row.winnerDisplayName!,
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

const sellerUsers = alias(users, 'seller');
const leaderUsers = alias(users, 'leader');
const winnerUsers = alias(users, 'winner');

function auctionSelect(db: ReturnType<typeof createDb>) {
  return db
    .select({
      id: auctions.id,
      slug: auctions.slug,
      title: auctions.title,
      kicker: auctions.kicker,
      category: auctions.category,
      art: auctions.art,
      description: auctions.description,
      condition: auctions.condition,
      location: auctions.location,
      startingPriceCents: auctions.startingPriceCents,
      currentAmountCents: auctions.currentAmountCents,
      bidCount: auctions.bidCount,
      closingTime: auctions.closingTime,
      closedAt: auctions.closedAt,
      winnerId: auctions.winnerId,
      winningAmountCents: auctions.winningAmountCents,
      specifications: auctions.specifications,
      sellerId: auctions.sellerId,
      sellerHandle: sellerUsers.handle,
      sellerDisplayName: sellerUsers.displayName,
      leadingBidderId: auctions.leadingBidderId,
      leadingBidderHandle: leaderUsers.handle,
      leadingBidderDisplayName: leaderUsers.displayName,
      winnerHandle: winnerUsers.handle,
      winnerDisplayName: winnerUsers.displayName,
    })
    .from(auctions)
    .innerJoin(sellerUsers, eq(sellerUsers.id, auctions.sellerId))
    .leftJoin(leaderUsers, eq(leaderUsers.id, auctions.leadingBidderId))
    .leftJoin(winnerUsers, eq(winnerUsers.id, auctions.winnerId));
}

async function loadBids(db: ReturnType<typeof createDb>, auctionId: string) {
  const rows = await db
    .select({
      id: bids.id,
      amountCents: bids.amountCents,
      createdAt: bids.createdAt,
      bidderId: bids.bidderId,
      bidderHandle: users.handle,
      bidderDisplayName: users.displayName,
    })
    .from(bids)
    .innerJoin(users, eq(users.id, bids.bidderId))
    .where(eq(bids.auctionId, auctionId))
    .orderBy(desc(bids.createdAt), desc(bids.amountCents));

  return rows.map((row) => ({
    id: row.id,
    amountCents: row.amountCents,
    createdAt: new Date(row.createdAt).toISOString(),
    bidder: {
      id: row.bidderId,
      handle: row.bidderHandle,
      displayName: row.bidderDisplayName,
    },
  }));
}

export function buildApp(options: BuildAppOptions = {}) {
  const now: AppClock = options.now ?? (() => new Date());
  const publishAuctionChanged: PublishAuctionChanged =
    options.publishAuctionChanged ?? (async () => undefined);
  const checkRedis: RedisHealthCheck = options.checkRedis ?? (async () => true);
  const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  const db = createDb(pool);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/api/health', async (request, reply) => {
    let database: 'ok' | 'down' = 'down';
    let redis: 'ok' | 'down' = 'down';
    try {
      await db.execute(sql`select 1`);
      database = 'ok';
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
    }
    try {
      redis = (await checkRedis()) ? 'ok' : 'down';
    } catch (error) {
      request.log.error({ err: error }, 'redis health check failed');
      redis = 'down';
    }
    if (database !== 'ok' || redis !== 'ok') {
      return reply.code(503).send({ ok: false, db: database, redis, requestId: request.id });
    }
    return { ok: true, db: database, redis, requestId: request.id };
  });

  app.get('/api/users', async () => {
    const rows = await db
      .select({
        id: users.id,
        handle: users.handle,
        displayName: users.displayName,
      })
      .from(users)
      .orderBy(asc(users.displayName));
    return { users: rows };
  });

  app.get<{ Params: { userId: string } }>(
    '/api/users/:userId/close-notifications',
    async (request, reply) => {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, request.params.userId))
        .limit(1);
      if (!user) {
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
      const body = z.object({ userId: z.string().uuid() }).safeParse(request.body);
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
    const rows = await auctionSelect(db).orderBy(asc(auctions.closingTime));
    return { auctions: rows.map((row) => serializeAuction(row as AuctionView, at)) };
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

    const [seller] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.sellerId))
      .limit(1);
    if (!seller) {
      return reply.code(400).send({ error: 'Seller not found' });
    }

    const id = randomUUID();
    let slug = slugifyTitle(input.title);
    const existing = await db
      .select({ slug: auctions.slug })
      .from(auctions)
      .where(or(eq(auctions.slug, slug), like(auctions.slug, `${slug}-%`)));
    if (existing.some((row) => row.slug === slug)) {
      slug = `${slug}-${id.slice(0, 8)}`;
    }

    await db.insert(auctions).values({
      id,
      slug,
      title: input.title,
      kicker: '',
      category: input.category,
      art,
      description: input.description,
      condition: input.condition,
      location: input.location,
      startingPriceCents: input.startingPriceCents,
      currentAmountCents: input.startingPriceCents,
      bidCount: 0,
      leadingBidderId: null,
      sellerId: input.sellerId,
      closingTime,
      specifications: [],
    });

    const [row] = await auctionSelect(db).where(eq(auctions.id, id)).limit(1);
    if (!row) {
      return reply.code(500).send({ error: 'Auction created but could not be loaded' });
    }

    return reply.code(201).send({ auction: serializeAuction(row as AuctionView, at), bids: [] });
  });

  app.get<{ Params: { slug: string } }>('/api/auctions/:slug', async (request, reply) => {
    const [row] = await auctionSelect(db).where(eq(auctions.slug, request.params.slug)).limit(1);
    if (!row) {
      return reply.code(404).send({ error: 'Auction not found' });
    }
    const auctionBids = await loadBids(db, row.id);
    return { auction: serializeAuction(row as AuctionView, now()), bids: auctionBids };
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

    type BidResult =
      | { kind: 'not_found' }
      | { kind: 'ended' }
      | { kind: 'forbidden' }
      | { kind: 'bidder_missing' }
      | {
          kind: 'too_low';
          minimumBidCents: number;
          auctionId: string;
          acceptedAt: Date;
        }
      | { kind: 'accepted'; auctionId: string; acceptedAt: Date };

    let result: BidResult;
    try {
      result = await db.transaction(async (tx): Promise<BidResult> => {
        // BEGIN → lock auction row → read clock + latest price → validate → insert → COMMIT
        const [auction] = await tx
          .select({
            id: auctions.id,
            sellerId: auctions.sellerId,
            currentAmountCents: auctions.currentAmountCents,
            closingTime: auctions.closingTime,
            closedAt: auctions.closedAt,
          })
          .from(auctions)
          .where(eq(auctions.slug, request.params.slug))
          .for('update');

        if (!auction) {
          return { kind: 'not_found' };
        }

        const acceptedAt = now();
        if (
          auction.closedAt !== null ||
          auction.closingTime.getTime() <= acceptedAt.getTime()
        ) {
          return { kind: 'ended' };
        }

        if (auction.sellerId === bidderId) {
          return { kind: 'forbidden' };
        }

        const [bidder] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, bidderId))
          .limit(1);
        if (!bidder) {
          return { kind: 'bidder_missing' };
        }

        const minimumBidCents = auction.currentAmountCents + MIN_INCREMENT_CENTS;
        if (amountCents < minimumBidCents) {
          return {
            kind: 'too_low',
            minimumBidCents,
            auctionId: auction.id,
            acceptedAt,
          };
        }

        const bidId = randomUUID();
        await tx.insert(bids).values({
          id: bidId,
          auctionId: auction.id,
          bidderId,
          amountCents,
          createdAt: acceptedAt,
        });
        await tx
          .update(auctions)
          .set({
            currentAmountCents: amountCents,
            bidCount: sql`${auctions.bidCount} + 1`,
            leadingBidderId: bidderId,
          })
          .where(eq(auctions.id, auction.id));

        return { kind: 'accepted', auctionId: auction.id, acceptedAt };
      });
    } catch (error) {
      throw error;
    }

    if (result.kind === 'not_found') {
      return reply.code(404).send({ error: 'Auction not found' });
    }
    if (result.kind === 'ended') {
      return reply.code(400).send({ error: 'This auction has ended' });
    }
    if (result.kind === 'forbidden') {
      return reply.code(403).send({ error: 'Sellers cannot bid on their own auctions' });
    }
    if (result.kind === 'bidder_missing') {
      return reply.code(400).send({ error: 'Bidder not found' });
    }
    if (result.kind === 'too_low') {
      const [row] = await auctionSelect(db).where(eq(auctions.id, result.auctionId)).limit(1);
      const auctionBids = row ? await loadBids(db, row.id) : [];
      return reply.code(400).send({
        error: `Bid must be at least $1.00 above the current amount (minimum ${result.minimumBidCents} cents)`,
        minimumBidCents: result.minimumBidCents,
        auction: row ? serializeAuction(row as AuctionView, result.acceptedAt) : undefined,
        bids: auctionBids,
      });
    }

    try {
      await publishAuctionChanged(request.params.slug);
    } catch (error) {
      request.log.error({ err: error, slug: request.params.slug }, 'auction-changed publish failed');
    }

    const [row] = await auctionSelect(db).where(eq(auctions.id, result.auctionId)).limit(1);
    if (!row) {
      return reply.code(500).send({ error: 'Bid saved but auction could not be reloaded' });
    }
    const auctionBids = await loadBids(db, row.id);
    return reply
      .code(201)
      .send({ auction: serializeAuction(row as AuctionView, result.acceptedAt), bids: auctionBids });
  });

  app.addHook('onClose', async () => pool.end());
  return app;
}
