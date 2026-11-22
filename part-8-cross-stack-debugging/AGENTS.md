# Auction House workshop — Part 8

- `server/` contains the Fastify API, Socket.IO realtime transport, PostgreSQL migrations,
  the Auction Close Worker, the Notification Worker, Winner Checkout / Stripe webhook handling,
  and OpenTelemetry export to part-local Jaeger.
- `web/` contains the React + Vite UI (no in-app trace UI).
- Repo-root `../stripe-service` is the local Stripe-shaped mock (port `7108`).
- PostgreSQL is shared from `../docker-compose.yml`; this part uses `auction_part_8` on
  host port 55432. Redis, RabbitMQ, and Jaeger are part-local via `./docker-compose.yml`
  (`127.0.0.1:6308` Redis, `127.0.0.1:5608` / UI `15608` RabbitMQ, Jaeger UI `16608`,
  OTLP HTTP `4308`). The API runs on 3108 and the web app on 5108.
- Read `CONTEXT.md` and `GRILL.md` before changing checkout, close, realtime, or tracing.
- Preserve Part 3 concurrency protection (`SELECT … FOR UPDATE`); emit bid fan-out only after commit.
- Purchase amount is server-owned from the recorded Winning amount. Paid requires a valid signed webhook.
- Purchase / payment details are visible only to the Seller and Winner (pass `viewerId` on auction detail).
- Baseline is Part 7. Do not pull Part 5. Do not depend on the Part 6 Drizzle worktree/PR.
- High-signal tracing only: suppress health/poll/framework noise; scrub SQL and PII from spans.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run infra:up`, `npm run migrate`, `npm run dev`, `npm start`, `npm test`,
`npm run typecheck`, `npm run test:bidding-war`, `npm run test:live-updates`,
`npm run test:close-notifications`, and `npm run test:checkout-recovery`.

## Verification commands

Bring the stack up (Postgres + Redis/RabbitMQ/Jaeger + migrate + API/web/workers + mock Stripe):

```bash
npm start
```

Typecheck and automated tests (requires mock Stripe on `7108` for checkout tests):

```bash
npm run typecheck
npm test
npm --prefix ../stripe-service test
```

Jaeger UI: <http://127.0.0.1:16608>. Service `auction-api`. After placing or rejecting a Bid
in the app (<http://localhost:5108>), search recent traces for `POST` `/api/auctions/:slug/bids`
and confirm `bid.outcome` plus related IDs/amounts — without health or GET-poll spam.

Headed bidding war:

```bash
# PowerShell
$env:BIDDING_WAR_HOLD_MS = '900000'
npm run test:bidding-war
```

Checkout recovery / seller visibility browser check:

```bash
npm run test:checkout-recovery
```

Mock Stripe test cards: success `4242 4242 4242 4242`, decline `4000 0000 0000 0002`.

`npm start` brings up Postgres DB + part-local Redis/RabbitMQ/Jaeger, migrates, installs the mock
Stripe deps if needed, then runs API, web, Close Worker, Notification Worker, and mock Stripe.
`npm run db:reset` restores Part 8 seed data.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser (and Jaeger).
