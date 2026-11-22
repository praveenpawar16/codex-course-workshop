# Auction House — Part 8

```sh
npm install
npm start
```

`npm start` ensures shared PostgreSQL plus part-local Redis/RabbitMQ/Jaeger, creates/migrates
`auction_part_8`, and starts the API, web app, workers, and mock Stripe.
Open <http://localhost:5108> (API `3108`) and Jaeger at <http://127.0.0.1:16608>.

Part 8 adds high-signal OpenTelemetry traces for the auction workflow. Slice 1 wires the API
to Jaeger with noise filters so Bid accept/reject paths are easy to find.
