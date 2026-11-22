# Socket.IO + Redis for auction-detail fan-out

Watchers on an Auction detail page need to learn about accepted Bids without polling. We attach Socket.IO to the Fastify HTTP server (one process), use Redis as the Socket.IO adapter backplane, and emit a small `auction-changed` notification only after the bid transaction commits. Clients join a per-auction room by slug and fetch authoritative state over HTTP. Rejected alternatives: embedding bid payloads on the socket (duplicates HTTP as source of truth) and a separate realtime microservice (out of deployment scope for a single instance).
