import Fastify from 'fastify';
import pg from 'pg';

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
