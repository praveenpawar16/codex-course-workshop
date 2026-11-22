# Auction House workshop — Part 5

- `server/` contains the Fastify API, Socket.IO realtime transport, and PostgreSQL migrations.
- `web/` contains the React + Vite UI.
- PostgreSQL is shared from `../docker-compose.yml`; this part uses `auction_part_5` on
  host port 55432. Redis is the shared Compose `redis` service on `127.0.0.1:56379`.
  The API runs on 3105 and the web app on 5105.
- Part 4 (`part-4-realtime-socketio-redis`) remains the protected realtime baseline — do not change it.
- Read `CONTEXT.md` and `GRILL.md` before changing bidding or realtime behavior.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run redis:up`, `npm run migrate`, `npm run dev`, `npm start`, `npm test`,
and `npm run test:live-updates`.

`npm run db:reset` is the explicit reset that restores Part 5 seed data. Normal
`npm start` applies pending migrations only and preserves existing rows. Redis must
be reachable before the API becomes ready.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser.
