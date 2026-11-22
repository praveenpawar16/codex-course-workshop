import { createHmac, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { closeDueAuctions } from './closeAuction.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local_part_7';

const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
const app = buildApp({ checkRedis: async () => true });

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function users() {
  const response = await app.inject({ method: 'GET', url: '/api/users' });
  return (response.json() as { users: Array<{ id: string }> }).users;
}

async function createSoldAuction(input: {
  sellerId: string;
  winnerId: string;
  title: string;
  winningAmountCents: number;
}) {
  const id = randomUUID();
  const slug = `pay-${id.slice(0, 8)}`;
  const past = new Date(Date.now() - 5_000);
  await pool.query(
    `INSERT INTO auctions (
      id, slug, title, kicker, category, art, description, condition, location,
      starting_price_cents, current_amount_cents, bid_count, leading_bidder_id, seller_id,
      closing_time, specifications
    ) VALUES (
      $1, $2, $3, '', 'Networking', 'switch', 'Checkout lot.', 'Used', 'Test Lab',
      $4, $4, 1, $5, $6, $7, '[]'::jsonb
    )`,
    [
      id,
      slug,
      input.title,
      input.winningAmountCents,
      input.winnerId,
      input.sellerId,
      past.toISOString(),
    ]
  );
  await closeDueAuctions(pool, { now: () => new Date(), limit: 50 });
  return { id, slug };
}

function sign(body: string) {
  return createHmac('sha256', webhookSecret).update(body).digest('hex');
}

describe('winner checkout', () => {
  beforeAll(async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const health = await fetch('http://127.0.0.1:7107/health');
        if (health.ok) return;
      } catch {
        // retry
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Mock Stripe is not running on 7107; start Part 7 (npm start) first');
  });

  it('allows only the winner, prices from the close outcome, and marks paid via signed webhook', async () => {
    const all = await users();
    const sellerId = all[0]!.id;
    const winnerId = all[1]!.id;
    const otherId = all[2]!.id;
    const amount = 15_500;
    const { slug } = await createSoldAuction({
      sellerId,
      winnerId,
      title: `Checkout Auth ${Date.now()}`,
      winningAmountCents: amount,
    });

    const denied = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/checkout`,
      payload: { userId: otherId },
    });
    expect(denied.statusCode).toBe(403);

    const started = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/checkout`,
      payload: { userId: winnerId },
    });
    expect(started.statusCode).toBe(200);
    const startedBody = started.json() as {
      purchase: { id: string; status: string; amountCents: number };
      checkoutUrl: string;
    };
    expect(startedBody.purchase).toMatchObject({ status: 'unpaid', amountCents: amount });
    expect(startedBody.checkoutUrl).toMatch(/^http:\/\/127\.0\.0\.1:7107\/checkout\/cs_test_/);

    const detail = await app.inject({ method: 'GET', url: `/api/auctions/${slug}` });
    expect(detail.json().auction.purchase).toMatchObject({
      status: 'unpaid',
      amountCents: amount,
    });

    const eventId = randomUUID();
    const payload = {
      eventId,
      eventType: 'checkout.session.completed',
      occurredAt: new Date().toISOString(),
      data: {
        object: {
          id: 'cs_test_unit',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          client_reference_id: startedBody.purchase.id,
          amount_total: amount,
          currency: 'usd',
        },
      },
    };
    const body = JSON.stringify(payload);

    const badSig = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'x-stripe-signature': 'nope' },
      payload: body,
    });
    expect(badSig.statusCode).toBe(401);

    const paid = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'x-stripe-signature': sign(body) },
      payload: body,
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({
      ok: true,
      purchase: { status: 'paid', amountCents: amount },
      replayed: false,
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'x-stripe-signature': sign(body) },
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, replayed: true, purchase: { status: 'paid' } });

    const after = await app.inject({ method: 'GET', url: `/api/auctions/${slug}` });
    expect(after.json().auction.purchase.status).toBe('paid');

    const again = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/checkout`,
      payload: { userId: winnerId },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      checkoutUrl: null,
      purchase: { status: 'paid' },
    });
  });

  it('keeps the purchase unpaid after a declined mock payment', async () => {
    const all = await users();
    const sellerId = all[0]!.id;
    const winnerId = all[1]!.id;
    const amount = 9_900;
    const { slug } = await createSoldAuction({
      sellerId,
      winnerId,
      title: `Checkout Decline ${Date.now()}`,
      winningAmountCents: amount,
    });

    const started = await app.inject({
      method: 'POST',
      url: `/api/auctions/${slug}/checkout`,
      payload: { userId: winnerId },
    });
    const checkoutUrl = (started.json() as { checkoutUrl: string }).checkoutUrl;
    const sessionId = checkoutUrl.split('/').pop()!;

    const declined = await fetch(`http://127.0.0.1:7107/v1/checkout/sessions/${sessionId}/attempt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardNumber: '4000 0000 0000 0002', expiry: '12 / 30', cvc: '123' }),
    });
    expect(declined.status).toBe(402);

    const detail = await app.inject({ method: 'GET', url: `/api/auctions/${slug}` });
    expect(detail.json().auction.purchase.status).toBe('unpaid');
  });
});
