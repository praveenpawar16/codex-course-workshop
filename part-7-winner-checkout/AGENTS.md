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
- Baseline is Part 6. Do not pull Part 5. Do not depend on the Part 6 Drizzle worktree/PR.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run infra:up`, `npm run migrate`, `npm run dev`, `npm start`, `npm test`,
`npm run test:bidding-war`, `npm run test:live-updates`, and
`npm run test:close-notifications`.

`npm start` brings up Postgres DB + part-local Redis/RabbitMQ, migrates, installs the mock
Stripe deps if needed, then runs API, web, Close Worker, Notification Worker, and mock Stripe.
`npm run db:reset` restores Part 7 seed data.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser.
