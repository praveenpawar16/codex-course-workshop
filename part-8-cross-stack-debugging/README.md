# Auction House — Part 8: Cross-stack debugging

```sh
npm install
npm start
```

`npm start` ensures shared PostgreSQL plus part-local Redis, RabbitMQ, and Jaeger, creates and
migrates `auction_part_8`, and starts the API, web app, Auction Close Worker, Notification Worker,
and the mock Stripe service.

| What | Where |
| --- | --- |
| Web app | <http://localhost:5108> |
| API | `3108` |
| Mock Stripe | `7108` |
| Jaeger UI | <http://localhost:16608> |
| RabbitMQ UI | <http://localhost:15608> (`auction` / `auction`) |

## How an auction flows

After Closing time, the Close Worker records Closed (Winner or Unsold) with a transactional outbox
event and publishes to RabbitMQ only after broker confirmation. The Notification Worker consumes those
events, writes idempotent per-recipient notifications, and fans out through Redis → Socket.IO user
rooms as dismissible popups for the Seller and Winner (Seller only when Unsold). The Winner can then
check out through the mock Stripe service; a valid signed webhook marks the Purchase Paid.

## Observability

Every process exports OpenTelemetry spans to Jaeger over OTLP/HTTP (`4308`). The accepted Winning Bid
stores its W3C `traceparent`, and each later step continues that same trace across the outbox,
RabbitMQ, the checkout HTTP call, and the Stripe webhook:

```
bid → auction.close.record → auction.close.publish → auction.close.notify
    → auction.checkout → stripe-mock → purchase.mark_paid
```

Jaeger services: `auction-api`, `auction-close-worker`, `auction-notification-worker`, `stripe-mock`.
Walk through it in the browser with [`GOLDEN_TRACE.md`](./GOLDEN_TRACE.md).

Rejected bids, declined cards, and replayed webhooks are recorded as outcome attributes, not errors.
Health checks, Socket.IO, routine reads, and the hosted checkout page are filtered out of traces.

## Checks

```sh
npm run typecheck
npm test
npm --prefix ../stripe-service test
```
