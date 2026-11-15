import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_2';

const app = buildApp();
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
  it('reports a healthy database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, db: 'ok' });
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

    const selfBid = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId: sellerId, amountCents: 10100 },
    });
    expect(selfBid.statusCode).toBe(403);

    const tooLow = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10000 },
    });
    expect(tooLow.statusCode).toBe(400);
    expect(tooLow.json()).toMatchObject({ minimumBidCents: 10100 });

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/bids`,
      payload: { bidderId, amountCents: 10100 },
    });
    expect(accepted.statusCode).toBe(201);
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
});
