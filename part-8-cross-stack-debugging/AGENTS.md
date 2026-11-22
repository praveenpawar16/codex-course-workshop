# Auction House workshop — Part 8

- `server/` contains the Fastify API, Socket.IO realtime transport, PostgreSQL migrations,
  the Auction Close Worker, the Notification Worker, Winner Checkout / Stripe webhook handling,
  and the OpenTelemetry instrumentation.
- `web/` contains the React + Vite UI.
- Repo-root `../stripe-service` is the local Stripe-shaped mock (port `7108`). It is shared with
  Part 7; its telemetry only turns on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Do not edit Part 7.
- PostgreSQL is shared from `../docker-compose.yml`; this part uses `auction_part_8` on
  host port 55432. Redis, RabbitMQ, and Jaeger are part-local via `./docker-compose.yml`
  (`127.0.0.1:6308` Redis, `127.0.0.1:5608` / UI `15608` RabbitMQ, Jaeger UI `16608`,
  OTLP/HTTP `4308`). The API runs on 3108 and the web app on 5108.
- Read `CONTEXT.md` and `GRILL.md` before changing checkout, close, realtime, or tracing.
- Preserve Part 3 concurrency protection (`SELECT … FOR UPDATE`); emit bid fan-out only after commit.
- Purchase amount is server-owned from the recorded Winning amount. Paid requires a valid signed webhook.
- Purchase / payment details are visible only to the Seller and Winner (pass `viewerId` on auction detail).

## Observability rules

One trace should span bid → close → publish → notify → checkout → mock Stripe → Paid.

- Every process (API, both workers, mock Stripe) loads its `otel.ts` as its **first import**.
- Context crosses durable boundaries as a W3C `traceparent`: `bids.trace_context`,
  `purchases.trace_context`, outbox `payload.traceparent`, AMQP header `traceparent`, and the HTTP
  `traceparent` header plus Checkout Session `metadata.traceparent`.
- Use `withContinuedTrace` / `currentTraceparent` / `isTraceparent` from `server/src/traceContext.ts`
  and `recordBidOutcome` from `server/src/tracing.ts`; do not hand-roll propagation.
- Rejected bids, declined cards, and replayed webhooks are business outcomes: record them as
  attributes with an Ok status, never as errors.
- Span attributes carry IDs, slugs, amounts, roles, and outcomes only. No names, handles, card data,
  SQL text, or message bodies. `otelFilters.ts` scrubs and drops noise at export; extend it rather than
  working around it.
- `otel.ts` is a no-op under Vitest or `OTEL_SDK_DISABLED=true`.
- Trace changes ship with a test (`otelFilters.test.ts`, `traceContext.test.ts`) and an update to
  `GOLDEN_TRACE.md` if the span map changes.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run infra:up`, `npm run migrate`, `npm run dev`, `npm start`, `npm test`,
`npm run typecheck`, `npm run test:bidding-war`, `npm run test:live-updates`,
`npm run test:close-notifications`, and `npm run test:checkout-recovery`.

## Verification commands

Bring the stack up (Postgres + Redis/RabbitMQ/Jaeger + migrate + API/web/workers + mock Stripe):

```bash
npm start
```

Typecheck and automated tests (the DB-backed tests need Postgres and the mock Stripe on `7108`):

```bash
npm run typecheck
npm test
npm --prefix ../stripe-service run typecheck
npm --prefix ../stripe-service test
```

Headed bidding war (protected concurrent bidding, durable close, seller/winner close
notification modals). Leave windows open to finish winner checkout manually:

```bash
# PowerShell
$env:BIDDING_WAR_HOLD_MS = '900000'
npm run test:bidding-war
```

Checkout recovery / seller visibility browser check (headed; keeps windows open):

```bash
npm run test:checkout-recovery
```

Trace check: follow [`GOLDEN_TRACE.md`](./GOLDEN_TRACE.md) and confirm a single `auction-api` trace
contains every span in the span map.

Mock Stripe test cards: success `4242 4242 4242 4242`, decline `4000 0000 0000 0002`.

`npm start` brings up Postgres DB + part-local Redis/RabbitMQ/Jaeger, migrates, installs the mock
Stripe deps if needed, then runs API, web, Close Worker, Notification Worker, and mock Stripe.
`npm run db:reset` restores Part 8 seed data.

Build the least that demonstrates the behavior; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser.
