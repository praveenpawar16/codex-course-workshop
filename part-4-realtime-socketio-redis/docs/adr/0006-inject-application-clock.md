# Inject an application clock

Closing-time acceptance must be deterministic in tests. The API takes an injectable clock (`now(): Date`) used after the Auction-row lock when deciding Open vs Ended, instead of monkey-patching global `Date`. Production defaults to wall clock; tests advance or freeze time explicitly.
