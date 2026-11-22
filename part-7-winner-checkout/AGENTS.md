# Auction House workshop — Part 7

- `server/` contains the Fastify API, Socket.IO realtime transport, PostgreSQL migrations,
  the Auction Close Worker, the Notification Worker, and Winner Checkout / Stripe webhook handling.
- `web/` contains the React + Vite UI.
- Repo-root `../stripe-service` is the local Stripe-shaped mock (port `7107`).
- PostgreSQL is shared from `../docker-compose.yml`; this part uses `auction_part_7` on
  host port 55432. Redis and RabbitMQ are part-local via `./docker-compose.yml`
  (`127.0.0.1:6307` Redis, `127.0.0.1:5607` / UI `15607` RabbitMQ). The API runs on 3107
  and the web app on 5107.
- Read `CONTEXT.md` and `GRILL.md` before changing checkout, close, or realtime.
- Preserve Part 3 concurrency protection (`SELECT … FOR UPDATE`); emit bid fan-out only after commit.
- Purchase amount is server-owned from the recorded Winning amount. Paid requires a valid signed webhook.
- Purchase / payment details are visible only to the Seller and Winner (pass `viewerId` on auction detail).
- Baseline is Part 6. Do not pull Part 5. Do not depend on the Part 6 Drizzle worktree/PR.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run infra:up`, `npm run migrate`, `npm run dev`, `npm start`, `npm test`,
`npm run typecheck`, `npm run test:bidding-war`, `npm run test:live-updates`,
`npm run test:close-notifications`, and `npm run test:checkout-recovery`.

## Verification commands

Bring the stack up (Postgres + Redis/RabbitMQ + migrate + API/web/workers + mock Stripe):

```bash
npm start
```

Typecheck and automated tests (requires mock Stripe on `7107` for checkout tests):

```bash
npm run typecheck
npm test
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

Mock Stripe test cards: success `4242 4242 4242 4242`, decline `4000 0000 0000 0002`.

`npm start` brings up Postgres DB + part-local Redis/RabbitMQ, migrates, installs the mock
Stripe deps if needed, then runs API, web, Close Worker, Notification Worker, and mock Stripe.
`npm run db:reset` restores Part 7 seed data.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser.
