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
  it('returns the six seeded auctions from postgres', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auctions' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      auctions: Array<{ slug: string; currentAmountCents: number }>;
    };
    expect(body.auctions).toHaveLength(6);
    expect(body.auctions.map((auction) => auction.slug)).toContain('nvidia-h100-sxm-80gb');
    expect(body.auctions[0]?.currentAmountCents).toEqual(expect.any(Number));
  });
});
