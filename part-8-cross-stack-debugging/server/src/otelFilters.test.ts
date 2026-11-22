import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';

import {
  scrubSpanAttributes,
  shouldDropSpanName,
  shouldIgnoreIncomingRequest,
} from './otelFilters.js';

function req(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

describe('otelFilters', () => {
  it('ignores health, socket.io, and routine GET auction/notification traffic', () => {
    expect(shouldIgnoreIncomingRequest(req('GET', '/api/health'))).toBe(true);
    expect(shouldIgnoreIncomingRequest(req('GET', '/socket.io/?EIO=4'))).toBe(true);
    expect(shouldIgnoreIncomingRequest(req('GET', '/api/auctions'))).toBe(true);
    expect(shouldIgnoreIncomingRequest(req('GET', '/api/auctions/demo-slug'))).toBe(true);
    expect(
      shouldIgnoreIncomingRequest(req('GET', '/api/users/u1/close-notifications'))
    ).toBe(true);
    expect(shouldIgnoreIncomingRequest(req('GET', '/api/users'))).toBe(true);
  });

  it('keeps bid, checkout, and webhook HTTP spans', () => {
    expect(shouldIgnoreIncomingRequest(req('POST', '/api/auctions/demo/bids'))).toBe(false);
    expect(shouldIgnoreIncomingRequest(req('POST', '/api/auctions/demo/checkout'))).toBe(
      false
    );
    expect(shouldIgnoreIncomingRequest(req('POST', '/api/webhooks/stripe'))).toBe(false);
    expect(shouldIgnoreIncomingRequest(req('POST', '/api/auctions'))).toBe(false);
  });

  it('scrubs SQL text and card-ish attributes', () => {
    const scrubbed = scrubSpanAttributes({
      'db.system': 'postgresql',
      'db.statement': 'SELECT * FROM users WHERE handle = $1',
      'http.route': '/api/auctions/:slug/bids',
      'user.handle': 'tensor-tamer',
      'payment.card_last4': '4242',
      'bid.amount_cents': 10100,
    });
    expect(scrubbed).toEqual({
      'db.system': 'postgresql',
      'http.route': '/api/auctions/:slug/bids',
      'bid.amount_cents': 10100,
    });
  });

  it('drops noisy framework span names', () => {
    expect(shouldDropSpanName('dns.lookup')).toBe(true);
    expect(shouldDropSpanName('redis-connect')).toBe(true);
    expect(shouldDropSpanName('pg.connect')).toBe(true);
    expect(shouldDropSpanName('POST')).toBe(false);
    expect(shouldDropSpanName('pg.query:INSERT auction_part_8')).toBe(false);
  });
});
