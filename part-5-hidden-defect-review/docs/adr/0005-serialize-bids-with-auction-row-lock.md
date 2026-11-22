# Serialize bids with an auction-row lock

Overlapping bids can both validate against the same Current amount if the read is unlocked. We accept Bids inside a transaction that locks the Auction row (`SELECT … FOR UPDATE`, blocking) and only then re-read, validate Minimum bid and Closing time, insert the Bid, and update the Auction. Rejected alternatives: optimistic version columns (more client retry surface) and `NOWAIT` (forces a retry protocol we are deferring).
