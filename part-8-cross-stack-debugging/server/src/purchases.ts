import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import {
  currentTraceparent,
  isTraceparent,
  recordBusinessOutcome,
  withContinuedTrace,
} from './traceContext.js';

export type PurchaseRow = {
  id: string;
  auction_id: string;
  winner_id: string;
  amount_cents: number;
  status: 'unpaid' | 'paid';
  stripe_checkout_session_id: string | null;
  paid_at: Date | null;
  created_at: Date;
  trace_context: string | null;
};

export type PurchaseView = {
  id: string | null;
  status: 'unpaid' | 'paid';
  amountCents: number;
  paidAt: string | null;
};

const stripeBaseUrl = process.env.STRIPE_BASE_URL ?? 'http://127.0.0.1:7108';
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local_part_8';
const webPublicUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:5108';

const webhookEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal('checkout.session.completed'),
  occurredAt: z.string(),
  data: z.object({
    object: z.object({
      id: z.string().startsWith('cs_'),
      object: z.literal('checkout.session'),
      status: z.literal('complete'),
      payment_status: z.literal('paid'),
      client_reference_id: z.string().uuid(),
      amount_total: z.number().int().positive(),
      currency: z.literal('usd'),
    }),
  }),
});

export function serializePurchase(row: PurchaseRow): PurchaseView {
  return {
    id: row.id,
    status: row.status,
    amountCents: row.amount_cents,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  };
}

/** Purchase details are only for the Seller or Winner of a sold Closed Auction. */
export function purchaseVisibleTo(input: {
  viewerId: string | null | undefined;
  sellerId: string;
  winnerId: string | null;
}): boolean {
  if (!input.viewerId || !input.winnerId) return false;
  return input.viewerId === input.sellerId || input.viewerId === input.winnerId;
}

export function unpaidPurchaseFromWinningAmount(amountCents: number): PurchaseView {
  return {
    id: null,
    status: 'unpaid',
    amountCents,
    paidAt: null,
  };
}

export async function clearCheckoutSession(
  pool: pg.Pool | pg.PoolClient,
  purchaseId: string
): Promise<void> {
  await pool.query(
    `UPDATE purchases SET stripe_checkout_session_id = NULL WHERE id = $1 AND status = 'unpaid'`,
    [purchaseId]
  );
}

export async function fetchCheckoutSession(
  sessionId: string
): Promise<{ id: string; url: string; status: string; payment_status: string } | null> {
  try {
    const response = await fetch(`${stripeBaseUrl}/v1/checkout/sessions/${sessionId}`);
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const body = (await response.json()) as {
      id?: string;
      url?: string;
      status?: string;
      payment_status?: string;
    };
    if (!body.id || !body.url || !body.status || !body.payment_status) return null;
    return {
      id: body.id,
      url: body.url,
      status: body.status,
      payment_status: body.payment_status,
    };
  } catch {
    return null;
  }
}

/**
 * Reuse a live mock session when present; if the stored session disappeared
 * (mock restart / memory wipe), clear it and create a fresh session for the same Purchase.
 */
export async function resolveCheckoutSession(input: {
  purchase: PurchaseRow;
  title: string;
  slug: string;
  pool: pg.Pool | pg.PoolClient;
}): Promise<{ id: string; url: string; recovered: boolean }> {
  if (input.purchase.stripe_checkout_session_id) {
    const existing = await fetchCheckoutSession(input.purchase.stripe_checkout_session_id);
    if (existing && existing.status === 'open') {
      return { id: existing.id, url: existing.url, recovered: false };
    }
    if (existing && existing.status === 'complete') {
      return { id: existing.id, url: existing.url, recovered: false };
    }
    await clearCheckoutSession(input.pool, input.purchase.id);
  }

  const created = await createCheckoutSession({
    purchaseId: input.purchase.id,
    title: input.title,
    amountCents: input.purchase.amount_cents,
    slug: input.slug,
    traceparent: input.purchase.trace_context,
  });
  const recovered = Boolean(input.purchase.stripe_checkout_session_id);
  return { ...created, recovered };
}

export async function loadPurchaseForAuction(
  pool: pg.Pool | pg.PoolClient,
  auctionId: string
): Promise<PurchaseRow | null> {
  const result = await pool.query<PurchaseRow>(
    `SELECT id, auction_id, winner_id, amount_cents, status, stripe_checkout_session_id, paid_at, created_at, trace_context
     FROM purchases WHERE auction_id = $1`,
    [auctionId]
  );
  return result.rows[0] ?? null;
}

export async function getOrCreatePurchase(
  client: pg.PoolClient,
  input: {
    auctionId: string;
    winnerId: string;
    amountCents: number;
    traceContext?: string | null;
  }
): Promise<PurchaseRow> {
  const existing = await client.query<PurchaseRow>(
    `SELECT id, auction_id, winner_id, amount_cents, status, stripe_checkout_session_id, paid_at, created_at, trace_context
     FROM purchases WHERE auction_id = $1 FOR UPDATE`,
    [input.auctionId]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.winner_id !== input.winnerId || row.amount_cents !== input.amountCents) {
      throw Object.assign(new Error('Purchase conflicts with recorded close outcome'), {
        statusCode: 409,
      });
    }
    // Keep an existing trace anchor; backfill only when the Purchase predates trace capture.
    if (!row.trace_context && input.traceContext) {
      const filled = await client.query<{ trace_context: string | null }>(
        `UPDATE purchases SET trace_context = $2 WHERE id = $1 AND trace_context IS NULL
         RETURNING trace_context`,
        [row.id, input.traceContext]
      );
      return { ...row, trace_context: filled.rows[0]?.trace_context ?? row.trace_context };
    }
    return row;
  }

  const id = randomUUID();
  const inserted = await client.query<PurchaseRow>(
    `INSERT INTO purchases (id, auction_id, winner_id, amount_cents, status, trace_context)
     VALUES ($1, $2, $3, $4, 'unpaid', $5)
     RETURNING id, auction_id, winner_id, amount_cents, status, stripe_checkout_session_id, paid_at, created_at, trace_context`,
    [id, input.auctionId, input.winnerId, input.amountCents, input.traceContext ?? null]
  );
  return inserted.rows[0]!;
}

export async function createCheckoutSession(input: {
  purchaseId: string;
  title: string;
  amountCents: number;
  slug: string;
  traceparent?: string | null;
}): Promise<{ id: string; url: string }> {
  const traceparent = isTraceparent(input.traceparent)
    ? input.traceparent.trim()
    : (currentTraceparent() ?? undefined);
  const successUrl = `${webPublicUrl}/auctions/${encodeURIComponent(input.slug)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${webPublicUrl}/auctions/${encodeURIComponent(input.slug)}?checkout=canceled`;
  const response = await fetch(`${stripeBaseUrl}/v1/checkout/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(traceparent ? { traceparent } : {}),
    },
    body: JSON.stringify({
      mode: 'payment',
      client_reference_id: input.purchaseId,
      ...(traceparent ? { metadata: { traceparent } } : {}),
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: input.title },
            unit_amount: input.amountCents,
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    }),
  });
  const body = (await response.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!response.ok || !body.id || !body.url) {
    throw Object.assign(
      new Error(body.error?.message ?? 'Could not create checkout session'),
      { statusCode: response.status >= 400 && response.status < 600 ? response.status : 502 }
    );
  }
  return { id: body.id, url: body.url };
}

export async function rememberCheckoutSession(
  client: pg.PoolClient,
  purchaseId: string,
  sessionId: string
): Promise<void> {
  await client.query(
    `UPDATE purchases SET stripe_checkout_session_id = $2 WHERE id = $1 AND status = 'unpaid'`,
    [purchaseId, sessionId]
  );
}

function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type WebhookResult =
  | { ok: true; purchase: PurchaseView; replayed: boolean; auctionSlug: string }
  | { ok: false; statusCode: number; error: string };

export async function applyStripeWebhook(
  pool: pg.Pool,
  rawBody: string,
  signatureHeader: string | undefined,
  options: { traceparent?: string } = {}
): Promise<WebhookResult> {
  if (!signatureHeader) {
    return { ok: false, statusCode: 400, error: 'Missing Stripe signature' };
  }
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  if (!signaturesMatch(expected, signatureHeader)) {
    return { ok: false, statusCode: 401, error: 'Invalid Stripe signature' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return { ok: false, statusCode: 400, error: 'Invalid JSON body' };
  }
  const parsed = webhookEventSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, statusCode: 400, error: 'Unsupported webhook payload' };
  }

  const event = parsed.data;
  const webhookTraceparent = isTraceparent(options.traceparent) ? options.traceparent : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const already = await client.query<{ purchase_id: string }>(
      `SELECT purchase_id FROM stripe_webhook_events WHERE event_id = $1`,
      [event.eventId]
    );
    if (already.rows[0]) {
      const purchase = await client.query<PurchaseRow & { auction_slug: string }>(
        `SELECT p.id, p.auction_id, p.winner_id, p.amount_cents, p.status, p.stripe_checkout_session_id,
                p.paid_at, p.created_at, p.trace_context, a.slug AS auction_slug
         FROM purchases p
         JOIN auctions a ON a.id = p.auction_id
         WHERE p.id = $1`,
        [already.rows[0].purchase_id]
      );
      await client.query('COMMIT');
      const row = purchase.rows[0];
      if (!row) {
        return { ok: false, statusCode: 500, error: 'Webhook event missing purchase' };
      }
      await withContinuedTrace(
        webhookTraceparent ?? row.trace_context,
        'purchase.mark_paid',
        { 'purchase.id': row.id, 'auction.id': row.auction_id },
        async (span) => {
          recordBusinessOutcome(span, 'replayed', { 'payment.outcome': 'replayed' });
        }
      );
      return {
        ok: true,
        purchase: serializePurchase(row),
        replayed: true,
        auctionSlug: row.auction_slug,
      };
    }

    const locked = await client.query<PurchaseRow>(
      `SELECT id, auction_id, winner_id, amount_cents, status, stripe_checkout_session_id, paid_at, created_at, trace_context
       FROM purchases WHERE id = $1 FOR UPDATE`,
      [event.data.object.client_reference_id]
    );
    const purchase = locked.rows[0];
    if (!purchase) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 404, error: 'Purchase not found' };
    }
    if (purchase.amount_cents !== event.data.object.amount_total) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 409, error: 'Webhook amount does not match Purchase' };
    }

    await withContinuedTrace(
      webhookTraceparent ?? purchase.trace_context,
      'purchase.mark_paid',
      {
        'purchase.id': purchase.id,
        'auction.id': purchase.auction_id,
        'purchase.amount_cents': purchase.amount_cents,
      },
      async (span) => {
        if (purchase.status === 'unpaid') {
          await client.query(
            `UPDATE purchases
             SET status = 'paid',
                 paid_at = now(),
                 stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2)
             WHERE id = $1`,
            [purchase.id, event.data.object.id]
          );
        }

        await client.query(
          `INSERT INTO stripe_webhook_events (event_id, purchase_id) VALUES ($1, $2)`,
          [event.eventId, purchase.id]
        );
        recordBusinessOutcome(span, purchase.status === 'unpaid' ? 'paid' : 'replayed', {
          'payment.outcome': purchase.status === 'unpaid' ? 'paid' : 'replayed',
        });
      }
    );

    const updated = await client.query<PurchaseRow & { auction_slug: string }>(
      `SELECT p.id, p.auction_id, p.winner_id, p.amount_cents, p.status, p.stripe_checkout_session_id,
              p.paid_at, p.created_at, p.trace_context, a.slug AS auction_slug
       FROM purchases p
       JOIN auctions a ON a.id = p.auction_id
       WHERE p.id = $1`,
      [purchase.id]
    );
    await client.query('COMMIT');
    const row = updated.rows[0]!;
    return {
      ok: true,
      purchase: serializePurchase(row),
      replayed: purchase.status === 'paid',
      auctionSlug: row.auction_slug,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
