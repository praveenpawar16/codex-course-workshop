# Auction House — Part 6

```sh
npm install
npm start
```

`npm start` ensures shared PostgreSQL plus part-local Redis/RabbitMQ, creates/migrates
`auction_part_6`, and starts the API, web app, and Auction Close Worker.
Open <http://localhost:5106> (API `3106`).

After Closing time, the Close Worker records Closed (Winner or Unsold) with a transactional
outbox event and publishes to RabbitMQ only after broker confirmation. The Notification
Worker consumes those events, writes idempotent per-recipient notifications, and fans out
through Redis → Socket.IO user rooms as dismissible popups for the Seller and Winner
(Seller only when Unsold).
