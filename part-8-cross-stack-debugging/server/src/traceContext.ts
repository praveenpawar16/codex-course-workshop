import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';

const TRACEPARENT_RE =
  /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

export function isTraceparent(value: unknown): value is string {
  return typeof value === 'string' && TRACEPARENT_RE.test(value.trim());
}

/** Serialize the active span as a W3C `traceparent` for durable / message boundaries. */
export function currentTraceparent(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const sc = span.spanContext();
  if (!trace.isSpanContextValid(sc)) return null;
  const flags = sc.traceFlags.toString(16).padStart(2, '0');
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  if (!isTraceparent(traceparent)) {
    return context.active();
  }
  return propagation.extract(context.active(), { traceparent: traceparent.trim() });
}

export async function withContinuedTrace<T>(
  traceparent: string | null | undefined,
  spanName: string,
  attributes: Record<string, string | number | boolean | undefined>,
  work: (span: Span) => Promise<T>
): Promise<T> {
  const parent = contextFromTraceparent(traceparent);
  const tracer = trace.getTracer('auction-house');
  const span = tracer.startSpan(spanName, undefined, parent);
  const attrs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) attrs[key] = value;
  }
  span.setAttributes(attrs);

  try {
    return await context.with(trace.setSpan(parent, span), async () => work(span));
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

export function recordBusinessOutcome(
  span: Span | undefined,
  outcome: string,
  extra: Record<string, string | number | boolean | undefined> = {}
): void {
  if (!span) return;
  const attrs: Record<string, string | number | boolean> = { outcome };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) attrs[key] = value;
  }
  span.setAttributes(attrs);
  span.setStatus({ code: SpanStatusCode.OK });
}
