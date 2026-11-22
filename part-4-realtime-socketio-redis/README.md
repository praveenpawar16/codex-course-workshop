# Auction House — Part 4

```sh
npm install
npm start
```

`npm start` ensures shared PostgreSQL + Redis, creates/migrates `auction_part_4`,
and starts both apps. Open <http://localhost:5104> (API `3104`).

Live auction-detail updates use Socket.IO with Redis as the backplane. Place a bid in
one browser session and watch another detail page update without refreshing.
