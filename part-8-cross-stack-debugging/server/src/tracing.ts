import { SpanStatusCode, trace } from '@opentelemetry/api';

export type BidOutcome =
  | 'accepted'
  | 'stale_bid'
  | 'ended'
  | 'seller_forbidden'
  | 'not_found'
  | 'invalid_body'
  | 'bidder_not_found'
  | 'reload_failed';

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

  span.setAttributes(attributes);
  span.setStatus({
    code: input.outcome === 'reload_failed' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
}
