import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';

import {
  scrubSpanAttributes,
  shouldDropSpanName,
  shouldIgnoreIncomingRequest,
} from './otelFilters.js';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'auction-api';
const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4308';

class FilteringSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    const kept: ReadableSpan[] = [];
    for (const span of spans) {
      if (shouldDropSpanName(span.name)) {
        continue;
      }
      const attrs = span.attributes as Record<string, unknown>;
      const scrubbed = scrubSpanAttributes(attrs);
      for (const key of Object.keys(attrs)) {
        if (!(key in scrubbed)) {
          delete attrs[key];
        }
      }
      kept.push(span);
    }
    this.delegate.export(kept, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush?(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

const exporter = new FilteringSpanExporter(
  new OTLPTraceExporter({
    url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
  })
);

const sdk = new NodeSDK({
  serviceName,
  spanProcessors: [new BatchSpanProcessor(exporter)],
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-redis': { enabled: false },
      '@opentelemetry/instrumentation-ioredis': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: shouldIgnoreIncomingRequest,
      },
      '@opentelemetry/instrumentation-pg': {
        enhancedDatabaseReporting: false,
        requireParentSpan: true,
      },
    } as Parameters<typeof getNodeAutoInstrumentations>[0]),
  ],
});

sdk.start();
