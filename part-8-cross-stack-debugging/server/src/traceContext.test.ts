import { propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  contextFromTraceparent,
  currentTraceparent,
  isTraceparent,
  withContinuedTrace,
} from './traceContext.js';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('traceContext', () => {
  beforeAll(() => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  it('accepts only well-formed W3C traceparent values', () => {
    expect(isTraceparent(VALID)).toBe(true);
    expect(isTraceparent(`  ${VALID}  `)).toBe(true);
    expect(isTraceparent('00-short-00f067aa0ba902b7-01')).toBe(false);
    expect(isTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(false);
    expect(isTraceparent(`${VALID}, ${VALID}`)).toBe(false);
    expect(isTraceparent(undefined)).toBe(false);
    expect(isTraceparent(null)).toBe(false);
    expect(isTraceparent(42)).toBe(false);
  });

  it('extracts the remote span context from a valid traceparent', () => {
    const spanContext = trace.getSpanContext(contextFromTraceparent(VALID));
    expect(spanContext?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(spanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(spanContext?.isRemote).toBe(true);
  });

  it('falls back to the active context for missing or invalid traceparent', () => {
    expect(trace.getSpanContext(contextFromTraceparent(null))).toBeUndefined();
    expect(trace.getSpanContext(contextFromTraceparent('not-a-traceparent'))).toBeUndefined();
  });

  it('returns null for currentTraceparent when no span is active', () => {
    expect(currentTraceparent()).toBeNull();
  });

  it('runs work and returns its value even when tracing is not configured', async () => {
    const value = await withContinuedTrace(VALID, 'test.span', { 'test.attr': 'x' }, async () => 7);
    expect(value).toBe(7);
  });

  it('propagates errors from continued work', async () => {
    await expect(
      withContinuedTrace(null, 'test.span', {}, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});
