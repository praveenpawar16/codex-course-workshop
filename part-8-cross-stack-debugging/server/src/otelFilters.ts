import type { IncomingMessage } from 'node:http';

/** HTTP paths that are routine traffic, not auction workflow signal. */
export function shouldIgnoreIncomingRequest(req: IncomingMessage): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path === '/api/health' || path.startsWith('/socket.io')) {
    return true;
  }
  if (req.method === 'GET') {
    if (path === '/api/auctions' || path.startsWith('/api/auctions/')) {
      return true;
    }
    if (path === '/api/users' || path.startsWith('/api/users/')) {
      return true;
    }
    if (path === '/' || path.startsWith('/json/')) {
      return true;
    }
  }
  return false;
}

const SENSITIVE_ATTR_KEYS = new Set([
  'db.statement',
  'db.query.text',
  'http.request.body',
  'http.response.body',
  'messaging.message.body',
]);

/** Strip SQL text, payloads, and other high-cardinality secrets from exported spans. */
export function scrubSpanAttributes(
  attributes: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SENSITIVE_ATTR_KEYS.has(key)) {
      continue;
    }
    if (key.endsWith('.name') || key.endsWith('.handle') || key.includes('card')) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function shouldDropSpanName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('dns.lookup') ||
    lower.includes('tcp.connect') ||
    lower.includes('fs ') ||
    lower.startsWith('middleware -') ||
    lower.startsWith('redis') ||
    lower.startsWith('receive ') ||
    lower.startsWith('send ') ||
    lower === 'pg.connect' ||
    lower === 'pg-pool.connect'
  );
}
