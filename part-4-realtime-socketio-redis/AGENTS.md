# Auction House workshop — Part 4

- `server/` contains the Fastify API, Socket.IO realtime transport, and PostgreSQL migrations.
- `web/` contains the React + Vite UI.
- PostgreSQL is shared from `../docker-compose.yml`; this part uses `auction_part_4` on
  host port 55432. Redis is the shared Compose `redis` service on `127.0.0.1:56379`.
  The API runs on 3104 and the web app on 5104.
- Read `CONTEXT.md` and `GRILL.md` before changing realtime fan-out or bid publishing.
- Preserve Part 3 concurrency protection (`SELECT … FOR UPDATE`); emit only after commit.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run redis:up`, `npm run migrate`, `npm run dev`, `npm start`, `npm test`,
`npm run test:bidding-war`, and `npm run test:live-updates` (headed multi-window
live detail updates).

`npm run db:reset` is the explicit reset that restores Part 4 seed data. Normal
`npm start` applies pending migrations only and preserves existing rows. Redis must
be reachable before the API becomes ready.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser.
