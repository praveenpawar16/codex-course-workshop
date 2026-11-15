# Auction House workshop — Part 3

- `server/` contains the Fastify API and PostgreSQL migrations.
- `web/` contains the React + Vite UI.
- PostgreSQL is shared from `../docker-compose.yml`; this part uses `auction_part_3` on
  host port 55432. The API runs on 3103 and the web app on 5103.
- Read `CONTEXT.md` and `GRILL.md` before changing bid concurrency or closing-time behavior.
- Part 2 remains the unprotected bug-reproduction baseline; do not change it for this work.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run migrate`, `npm run dev`, `npm start`, `npm test`, and
`npm run test:bidding-war` (headed Microsoft Edge Bidding War; optional
`BIDDING_WAR_HOLD_MS` keeps the tiled windows open after assertions).

`npm run db:reset` is the explicit reset that restores Part 3 seed data. Normal
`npm start` applies pending migrations only and preserves existing rows.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and user-facing changes must be verified in the browser.
