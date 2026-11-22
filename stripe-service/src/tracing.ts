import type * as OtelApi from '@opentelemetry/api';

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

// Optional at runtime: if the package is missing, tracing helpers are no-ops.
let api: typeof OtelApi | undefined;
try {
  api = await import('@opentelemetry/api');
} catch {
  api = undefined;
}

export function isTraceparent(value: unknown): value is string {
  return typeof value === 'string' && TRACEPARENT_RE.test(value.trim());
}

/** First valid traceparent in a possibly comma-joined header value. */
export function pickTraceparent(value: unknown): string | null {
  if (Array.isArray(value)) return pickTraceparent(value.join(','));
  if (typeof value !== 'string') return null;
  return (
    value
      .split(',')
      .map((part) => part.trim())
      .find((part) => TRACEPARENT_RE.test(part)) ?? null
  );
}

/** Run work inside a span continued from `traceparent`; plain call when tracing is off. */
export async function withContinuedTrace<T>(
  traceparent: string | null | undefined,
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  work: () => Promise<T>
): Promise<T> {
  if (!api || !isTraceparent(traceparent)) return work();
  const { context, propagation, trace, SpanStatusCode } = api;
  const parent = propagation.extract(context.active(), { traceparent: traceparent.trim() });
  const span = trace.getTracer('stripe-mock').startSpan(spanName, { attributes }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), work);
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

/** Business outcomes (declines included) are not errors. */
export function recordPaymentOutcome(outcome: 'paid' | 'declined'): void {
  const span = api?.trace.getActiveSpan();
  if (!span || !api) return;
  span.setAttribute('payment.outcome', outcome);
  span.setStatus({ code: api.SpanStatusCode.OK });
}
