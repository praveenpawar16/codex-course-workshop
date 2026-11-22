# GOLDEN_TRACE.md — one trace from bid to Paid

Follow one winning auction through the stack and find the single Jaeger trace that covers it.
Use Chrome or Edge.

## 1. Start the stack

```sh
cd part-8-cross-stack-debugging
npm install
npm start
```

Wait until the API, web app, both workers, and mock Stripe are up. Jaeger is at
<http://127.0.0.1:16608>.

## 2. Place a winning bid

1. Open <http://localhost:5108>.
2. Create an auction that closes in about one minute (or open one that is about to close), as the Seller.
3. In a second window, switch to a different Active User and open that auction.
4. Place a bid at or above the minimum. Make it the highest bid and don't let anyone outbid it.

This is the **Winning Bid**. The API stores its trace context in `bids.trace_context`.

## 3. Wait for close

1. Wait past the Closing time. The Close Worker records Closed and publishes `auction.closed`.
2. The Winner and Seller each get a close notification popup (this is the Notification Worker).

## 4. Check out

1. As the Winner, choose **Complete purchase** on the closed auction.
2. On the mock Stripe page, pay with `4242 4242 4242 4242`, any future expiry, any 3-digit CVC.
3. You return to the auction and it shows **Paid**.

Optional: try `4000 0000 0000 0002` first to see a decline, then retry with `4242…`.

## 5. Find the trace in Jaeger

1. Open Part 8 Jaeger at <http://127.0.0.1:16608> (mapped from container port 16686 — not the root Compose `16686` unless you started that separately).
2. **Service** → `auction-api`. **Operation** → `auction.bid.accept`.
3. **Lookback** → Last Hour. Choose **Find Traces**.
4. Pick the longest trace for your winning bid (it can span the close wait and human payment — that duration is wall clock, not CPU).

## What to see

The trace should show spans from four services:

| Order | Span | Service |
| --- | --- | --- |
| 1 | `auction.bid.accept` (`bid.outcome=accepted`) under the HTTP `POST` | `auction-api` |
| 2 | `auction.close.record` | `auction-close-worker` |
| 3 | `auction.close.publish` | `auction-close-worker` |
| 4 | `auction.close.notify` | `auction-notification-worker` |
| 5 | `auction.checkout` | `auction-api` |
| 6 | `POST /v1/checkout/sessions` | `stripe-mock` |
| 7 | `stripe.checkout.attempt` (`payment.outcome=paid`) | `stripe-mock` |
| 8 | `stripe.webhook.deliver` | `stripe-mock` |
| 9 | `POST /api/webhooks/stripe`, `purchase.mark_paid` (`payment.outcome=paid`) | `auction-api` |

Checks:

- The trace header lists `auction-api`, `auction-close-worker`, `auction-notification-worker`, and
  `stripe-mock`.
- No span is red. A declined card or a rejected bid shows as an attribute, not an error.
- No span carries SQL text, names, handles, or card data.
- Health checks, Socket.IO, list/detail `GET`s, and the hosted checkout page do not appear.

Rejected bids also leave a trace. Place a bid that is too low and search the same operation: the span
shows `bid.outcome=stale_bid` with an Ok status.

## If the trace is split

Search each service separately in Jaeger. A trace that stops at a boundary points to the missing
carrier:

| Trace stops after | Check |
| --- | --- |
| bid | `select trace_context from bids order by created_at desc limit 1;` should not be null |
| `auction.close.record` | The outbox row's `payload->>'traceparent'` is set |
| `auction.close.publish` | The `auction.close` message has an AMQP `traceparent` header (RabbitMQ UI → Get messages) |
| `auction.checkout` | `purchases.trace_context` is set; the mock received `metadata.traceparent` |
| `stripe-mock` | `OTEL_EXPORTER_OTLP_ENDPOINT` is set for the mock (`npm run dev:stripe`) |
