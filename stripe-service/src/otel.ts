import { shouldIgnoreStripeIncomingRequest } from './otelFilters.js';

/**
 * Light OpenTelemetry for the shared mock Stripe service. Disabled unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set so parts without a collector are unaffected.
 */
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otlpEndpoint && process.env.OTEL_SDK_DISABLED !== 'true' && !process.env.VITEST) {
  try {
    const [{ propagation }, { getNodeAutoInstrumentations }, core, otlp, sdkNode, sdkTraceBase] =
      await Promise.all([
        import('@opentelemetry/api'),
        import('@opentelemetry/auto-instrumentations-node'),
        import('@opentelemetry/core'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/sdk-trace-base'),
      ]);

    propagation.setGlobalPropagator(new core.W3CTraceContextPropagator());

    const sdk = new sdkNode.NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'stripe-mock',
      spanProcessors: [
        new sdkTraceBase.BatchSpanProcessor(
          new otlp.OTLPTraceExporter({
            url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
          })
        ),
      ],
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: shouldIgnoreStripeIncomingRequest,
          },
        } as Parameters<typeof getNodeAutoInstrumentations>[0]),
      ],
    });
    sdk.start();
  } catch (error) {
    // Telemetry must never prevent the mock from serving payments.
    console.error('stripe-mock OpenTelemetry failed to start', error);
  }
}
