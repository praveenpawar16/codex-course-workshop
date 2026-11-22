# Auction House workshop — Part 6

- `server/` contains the Fastify API, Socket.IO realtime transport, PostgreSQL migrations,
  the Auction Close Worker (`src/closeWorker.ts`), and the Notification Worker
  (`src/notificationWorker.ts`).
- Application database access uses **Drizzle ORM** (`drizzle-orm` + `pg`) via
  `server/src/db/`. Ordered SQL files under `server/migrations/` remain the DDL source.
- `web/` contains the React + Vite UI.
- PostgreSQL is shared from `../docker-compose.yml`; this part uses `auction_part_6` on
  host port 55432. Redis and RabbitMQ are part-local via `./docker-compose.yml`
  (`127.0.0.1:6306` Redis, `127.0.0.1:5606` / UI `15606` RabbitMQ). The API runs on 3106
  and the web app on 5106.
- Read `CONTEXT.md` and `GRILL.md` before changing close/notification workflow or realtime.
- Preserve Part 3 concurrency protection (`SELECT … FOR UPDATE` via Drizzle `.for('update')`);
  emit bid fan-out only after commit.
- Baseline is Part 4 (realtime). Do not pull Part 5 — it contains a deliberate defect.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run infra:up`, `npm run migrate`, `npm run dev`, `npm start`, `npm test`,
`npm run test:bidding-war`, `npm run test:live-updates`, and
`npm run test:close-notifications` (headed seller/winner popup check).

`npm start` brings up Postgres DB + part-local Redis/RabbitMQ, migrates, then runs API,
web, Close Worker, and Notification Worker. `npm run db:reset` restores Part 6 seed data.
Redis must be reachable before the API becomes ready; RabbitMQ must be reachable for the
workers to publish and consume close events.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser.
