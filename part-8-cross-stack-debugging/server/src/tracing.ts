import { context, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

import { currentTraceparent } from './traceContext.js';

export type BidOutcome =
  | 'accepted'
  | 'stale_bid'
  | 'ended'
  | 'seller_forbidden'
  | 'not_found'
  | 'invalid_body'
  | 'bidder_not_found'
  | 'reload_failed';

function bidAttributes(input: {
  auctionSlug: string;
  auctionId?: string;
  bidderId?: string;
  amountCents?: number;
  bidId?: string;
  actorRole?: 'bidder' | 'seller';
  outcome: BidOutcome;
}): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    'auction.slug': input.auctionSlug,
    'bid.outcome': input.outcome,
  };
  if (input.auctionId) {
    attributes['auction.id'] = input.auctionId;
  }
  if (input.bidderId) {
    attributes['bidder.id'] = input.bidderId;
  }
  if (input.amountCents !== undefined) {
    attributes['bid.amount_cents'] = input.amountCents;
  }
  if (input.bidId) {
    attributes['bid.id'] = input.bidId;
  }
  if (input.actorRole) {
    attributes['actor.role'] = input.actorRole;
  }
  return attributes;
}

/** Safe bid-route attributes: IDs, amounts, roles, outcomes — never names/handles. */
export function recordBidOutcome(input: {
  auctionSlug: string;
  auctionId?: string;
  bidderId?: string;
  amountCents?: number;
  bidId?: string;
  actorRole?: 'bidder' | 'seller';
  outcome: BidOutcome;
}): void {
  const span = trace.getActiveSpan();
  if (!span) {
    return;
  }

  span.setAttributes(bidAttributes(input));
  span.setStatus({
    code: input.outcome === 'reload_failed' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
}

/**
 * Named accept span searchable in Jaeger as Operation `auction.bid.accept`.
 * Returns the W3C context to persist on the bid row (anchors the long workflow).
 */
export async function withBidAcceptSpan<T>(
  input: {
    auctionSlug: string;
    auctionId: string;
    bidderId: string;
    amountCents: number;
    bidId: string;
  },
  work: () => Promise<T>
): Promise<{ result: T; traceContext: string | null }> {
  const tracer = trace.getTracer('auction-house');
  const span: Span = tracer.startSpan('auction.bid.accept');
  span.setAttributes(
    bidAttributes({
      ...input,
      actorRole: 'bidder',
      outcome: 'accepted',
    })
  );
  span.setStatus({ code: SpanStatusCode.OK });

  try {
    return await context.with(trace.setSpan(context.active(), span), async () => {
      const traceContext = currentTraceparent();
      const result = await work();
      return { result, traceContext };
    });
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

/** Capture the active bid span for later Close → Checkout continuation. */
export function captureActiveTraceContext(): string | null {
  return currentTraceparent();
}
