# Seed six auctions; only an explicit reset restores them

The six Part 1 catalog auctions are seeded into PostgreSQL so the app starts with a familiar collection. Normal startup preserves later creates and bids. An explicit reset command restores Part 2 seed data when a clean demo state is needed—so development and demos do not fight each other.
