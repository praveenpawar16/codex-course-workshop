import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const app = buildApp();
afterAll(() => app.close());

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
