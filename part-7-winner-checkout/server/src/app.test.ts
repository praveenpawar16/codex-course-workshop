import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';

const publishedSlugs: string[] = [];
const app = buildApp({
  publishAuctionChanged: (slug) => {
    publishedSlugs.push(slug);
  },
  checkRedis: async () => true,
});
afterAll(() => app.close());

async function createOpenAuction(sellerId: string, title: string, startingPriceCents = 10000) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auctions',
    payload: {
      sellerId,
      title,
      category: 'Networking',
      description: 'Bid test lot.',
      condition: 'Used',
      location: 'Test Lab',
      startingPriceCents,
      closingTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    auction: { id: string; slug: string; currentAmountCents: number; seller: { id: string } };
  };
}

describe('GET /api/health', () => {
  it('reports a healthy database and redis', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, db: 'ok', redis: 'ok' });
  });

  it('reports unhealthy when redis is down', async () => {
    const unhealthy = buildApp({
      checkRedis: async () => false,
    });
    try {
      const response = await unhealthy.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ ok: false, redis: 'down' });
    } finally {
      await unhealthy.close();
    }
  });
});

describe('post-commit auction-changed publish', () => {
  it('keeps the accepted bid when publish throws', async () => {
    const flaky = buildApp({
      checkRedis: async () => true,
      publishAuctionChanged: async () => {
        throw new Error('redis adapter unavailable');
      },
    });
    try {
      const usersResponse = await flaky.inject({ method: 'GET', url: '/api/users' });
      const users = (usersResponse.json() as { users: Array<{ id: string }> }).users;
      const sellerId = users[0]?.id!;
      const bidderId = users[1]?.id!;

      const created = await flaky.inject({
        method: 'POST',
        url: '/api/auctions',
        payload: {
          sellerId,
          title: `Publish Fail Lot ${Date.now()}`,
          category: 'Networking',
          description: 'Publish failure must not roll back.',
          condition: 'Used',
          location: 'Test Lab',
          startingPriceCents: 10000,
          closingTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
      });
      expect(created.statusCode).toBe(201);
      const slug = (created.json() as { auction: { slug: string } }).auction.slug;

      const accepted = await flaky.inject({
        method: 'POST',
        url: `/api/auctions/${slug}/bids`,
        payload: { bidderId, amountCents: 10100 },
      });
      expect(accepted.statusCode).toBe(201);

      const detail = await flaky.inject({ method: 'GET', url: `/api/auctions/${slug}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        auction: { currentAmountCents: 10100, bidCount: 1 },
        bids: [{ amountCents: 10100 }],
      });
    } finally {
      await flaky.close();
    }
  });
});

describe('GET /api/users', () => {
  it('returns the ten seeded demo users', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/users' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { users: unknown[] };
    expect(body.users).toHaveLength(10);
  });
});

describe('GET /api/auctions', () => {
  it('returns the seeded auctions from postgres', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auctions' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      auctions: Array<{ slug: string; currentAmountCents: number }>;
    };
    expect(body.auctions.length).toBeGreaterThanOrEqual(6);
    expect(body.auctions.map((auction) => auction.slug)).toContain('nvidia-h100-sxm-80gb');
    expect(body.auctions[0]?.currentAmountCents).toEqual(expect.any(Number));
  });
});

describe('POST /api/auctions', () => {
  it('creates an auction for a demo seller and returns it immediately', async () => {
    const usersResponse = await app.inject({ method: 'GET', url: '/api/users' });
    const sellerId = (usersResponse.json() as { users: Array<{ id: string }> }).users[0]?.id;
    expect(sellerId).toBeTruthy();

    const closingTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auctions',
      payload: {
        sellerId,
        title: 'Test Fiber Patch Panel',
        category: 'Networking',
        description: 'A tidy 48-port panel ready for the next rack.',
        condition: 'Used · Clean',
        location: 'Seattle, WA',
        startingPriceCents: 12550,
        closingTime,
      },
    });

    expect(response.json()).toMatchObject({ auction: expect.any(Object) });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      auction: {
        slug: string;
        startingPriceCents: number;
        currentAmountCents: number;
        seller: { id: string };
        art: string;
        specifications: unknown[];
      };
    };
    expect(body.auction.startingPriceCents).toBe(12550);
    expect(body.auction.currentAmountCents).toBe(12550);
    expect(body.auction.seller.id).toBe(sellerId);
    expect(body.auction.art).toBe('switch');
    expect(body.auction.specifications).toEqual([]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/auctions/${body.auction.slug}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ bids: [] });
  });

  it('rejects a closing time that is not in the future', async () => {
    const usersResponse = await app.inject({ method: 'GET', url: '/api/users' });
    const sellerId = (usersResponse.json() as { users: Array<{ id: string }> }).users[0]?.id;

    const response = await app.inject({
      method: 'POST',
      url: '/api/auctions',
      payload: {
        sellerId,
        title: 'Too Late Lot',
        category: 'Cooling',
        description: 'Should fail validation.',
        condition: 'Used',
        location: 'Austin, TX',
        startingPriceCents: 5000,
        closingTime: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/auctions/:slug/bids', () => {
  it('rejects seller self-bids, enforces the $1 minimum, accepts a valid bid, and rejects ended auctions', async () => {
    const usersResponse = await app.inject({ method: 'GET', url: '/api/users' });
    const users = (usersResponse.json() as { users: Array<{ id: string }> }).users;
    const sellerId = users[0]?.id!;
    const bidderId = users[1]?.id!;
    expect(sellerId).not.toBe(bidderId);

    const created = await createOpenAuction(sellerId, `Bid Rules Lot ${Date.now()}`, 10000);
    const slug = created.auction.slug;
    publishedSlugs.length = 0;

    const selfBid = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId: sellerId, amountCents: 10100 },
    });
    expect(selfBid.statusCode).toBe(403);
    expect(publishedSlugs).toEqual([]);

    const tooLow = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10000 },
    });
    expect(tooLow.statusCode).toBe(400);
    expect(tooLow.json()).toMatchObject({
      minimumBidCents: 10100,
      auction: expect.objectContaining({ currentAmountCents: 10000 }),
      bids: [],
    });
    expect(publishedSlugs).toEqual([]);

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10100 },
    });
    expect(accepted.statusCode).toBe(201);
    expect(publishedSlugs).toEqual([slug]);
    const acceptedBody = accepted.json() as {
      auction: { currentAmountCents: number; bidCount: number; leadingBidder: { id: string } };
      bids: Array<{ amountCents: number; bidder: { id: string } }>;
    };
    expect(acceptedBody.auction.currentAmountCents).toBe(10100);
    expect(acceptedBody.auction.bidCount).toBe(1);
    expect(acceptedBody.auction.leadingBidder.id).toBe(bidderId);
    expect(acceptedBody.bids[0]).toMatchObject({ amountCents: 10100, bidder: { id: bidderId } });

    const belowNewMin = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10150 },
    });
    expect(belowNewMin.statusCode).toBe(400);
    expect(belowNewMin.json()).toMatchObject({ minimumBidCents: 10200 });

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query(`UPDATE auctions SET closing_time = now() - interval '1 minute' WHERE slug = $1`, [
        slug,
      ]);
    } finally {
      await client.end();
    }

    const ended = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 11000 },
    });
    expect(ended.statusCode).toBe(400);
    expect(ended.json()).toMatchObject({ error: 'This auction has ended' });
  });

  it('serializes overlapping bids so only one identical amount is accepted', async () => {
    const usersResponse = await app.inject({ method: 'GET', url: '/api/users' });
    const users = (usersResponse.json() as { users: Array<{ id: string }> }).users;
    const sellerId = users[0]?.id!;
    const bidderA = users[1]?.id!;
    const bidderB = users[2]?.id!;
    const bidderC = users[3]?.id!;

    const created = await createOpenAuction(sellerId, `Concurrency Lock Lot ${Date.now()}`, 10000);
    const slug = created.auction.slug;
    const amountCents = 10100;

    const results = await Promise.all(
      [bidderA, bidderB, bidderC].map((bidderId) =>
        app.inject({
          method: 'POST',
          url: `/api/auctions/${slug}/bids`,
          payload: { bidderId, amountCents },
        })
      )
    );

    const accepted = results.filter((response) => response.statusCode === 201);
    const rejected = results.filter((response) => response.statusCode === 400);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(2);

    for (const response of rejected) {
      expect(response.json()).toMatchObject({
        minimumBidCents: 10200,
        auction: expect.objectContaining({ currentAmountCents: 10100, bidCount: 1 }),
      });
    }

    const detail = await app.inject({ method: 'GET', url: `/api/auctions/${slug}` });
    const body = detail.json() as {
      auction: { currentAmountCents: number; bidCount: number };
      bids: Array<{ amountCents: number }>;
    };
    expect(body.auction.currentAmountCents).toBe(10100);
    expect(body.auction.bidCount).toBe(1);
    expect(body.bids).toHaveLength(1);
    expect(body.bids.map((bid) => bid.amountCents)).toEqual([10100]);
  });
});

describe('closing time with injectable clock', () => {
  let currentMs = Date.parse('2030-06-01T12:00:00.000Z');
  const timedApp = buildApp({ now: () => new Date(currentMs) });
  afterAll(() => timedApp.close());

  async function createTimedAuction(sellerId: string, title: string, closingTime: string) {
    const response = await timedApp.inject({
      method: 'POST',
      url: '/api/auctions',
      payload: {
        sellerId,
        title,
        category: 'Networking',
        description: 'Clock-controlled closing lot.',
        condition: 'Used',
        location: 'Test Lab',
        startingPriceCents: 10000,
        closingTime,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { auction: { slug: string } };
  }

  it('accepts before closing, stamps acceptedAt from the clock, and rejects at and after closing', async () => {
    currentMs = Date.parse('2030-06-01T12:00:00.000Z');
    const closingTime = '2030-06-01T12:00:10.000Z';
    const usersResponse = await timedApp.inject({ method: 'GET', url: '/api/users' });
    const users = (usersResponse.json() as { users: Array<{ id: string }> }).users;
    const sellerId = users[0]?.id!;
    const bidderId = users[1]?.id!;

    const created = await createTimedAuction(sellerId, `Clock Close Lot ${Date.now()}`, closingTime);
    const slug = created.auction.slug;

    currentMs = Date.parse('2030-06-01T12:00:05.000Z');
    const before = await timedApp.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10100 },
    });
    expect(before.statusCode).toBe(201);
    const beforeBody = before.json() as {
      auction: { ended: boolean };
      bids: Array<{ createdAt: string; amountCents: number }>;
    };
    expect(beforeBody.auction.ended).toBe(false);
    expect(beforeBody.bids[0]?.amountCents).toBe(10100);
    expect(beforeBody.bids[0]?.createdAt).toBe(new Date(currentMs).toISOString());

    currentMs = Date.parse('2030-06-01T12:00:10.000Z');
    const atClose = await timedApp.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10200 },
    });
    expect(atClose.statusCode).toBe(400);
    expect(atClose.json()).toMatchObject({ error: 'This auction has ended' });

    currentMs = Date.parse('2030-06-01T12:00:11.000Z');
    const afterClose = await timedApp.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10300 },
    });
    expect(afterClose.statusCode).toBe(400);
    expect(afterClose.json()).toMatchObject({ error: 'This auction has ended' });
  });

  it('rejects a bid that only acquires the row lock after closing', async () => {
    currentMs = Date.parse('2030-06-01T13:00:00.000Z');
    const closingTime = '2030-06-01T13:00:05.000Z';
    const usersResponse = await timedApp.inject({ method: 'GET', url: '/api/users' });
    const users = (usersResponse.json() as { users: Array<{ id: string }> }).users;
    const sellerId = users[0]?.id!;
    const bidderId = users[1]?.id!;

    const created = await createTimedAuction(
      sellerId,
      `Lock Wait Past Close ${Date.now()}`,
      closingTime
    );
    const slug = created.auction.slug;

    const holder = new pg.Client({ connectionString });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM auctions WHERE slug = $1 FOR UPDATE', [slug]);

      currentMs = Date.parse('2030-06-01T13:00:06.000Z');
      const pending = timedApp.inject({
        method: 'POST',
        url: `/api/auctions/${slug}/bids`,
        payload: { bidderId, amountCents: 10100 },
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query('ROLLBACK');

      const late = await pending;
      expect(late.statusCode).toBe(400);
      expect(late.json()).toMatchObject({ error: 'This auction has ended' });
    } finally {
      await holder.end();
    }
  });
});
