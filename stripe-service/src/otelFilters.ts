import type { IncomingMessage } from 'node:http';

/** Mock Stripe paths that are not part of the payment workflow signal. */
export function shouldIgnoreStripeIncomingRequest(req: IncomingMessage): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path === '/health' || path === '/' || path.startsWith('/json/')) {
    return true;
  }
  if (req.method === 'GET' && path.startsWith('/checkout/')) {
    // Hosted page HTML is not the workflow signal; attempt + webhook are.
    return true;
  }
  return false;
}
