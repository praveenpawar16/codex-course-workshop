# GRILL.md — Part 2: Create auction and bid

Agreed decisions from the design conversation. Glossary: [`CONTEXT.md`](./CONTEXT.md). ADRs: [`docs/adr/`](./docs/adr/).

## Locked decisions

| Topic | Decision |
| --- | --- |
| Users | Ten seeded demo users with a footer switcher; no real authentication |
| Listing fields | Title, category, description, condition, location, starting price, closing time |
| Images | Category illustrations; no uploads |
| Publication | Auctions become visible immediately |
| Time | Future closing time stored as a UTC timestamp |
| Money | USD, stored as integer cents |
| Existing catalog | Seed the six existing auctions into PostgreSQL |
| Reset | Explicit reset restores Part 2 seed data; normal startup preserves changes |
| Active user | Each new browser tab picks a random demo user; keep that choice in sessionStorage so it survives navigation/reloads in the tab; footer switcher can change it; show the active user's name at the top right |
| Seller | Active user becomes the seller; sellers cannot bid on their own auctions |
| Minimum bid | At least $1 above the current amount, enforced by the API |
| Ended auctions | Disable bidding in the UI and reject bids in the API |
| Bid history | Show bidder, amount, and time |
| Posting | Sell link opens `/auctions/new`; success opens the new detail page |
| Specifications | Not required on create; hide the section when empty |
| Concurrent bids | Sequential bidding only in Part 2; concurrency protection deferred to Part 3 |

## Runtime

- Work in `part-2-create-auction-and-bid` (copy Part 1 foundation, then extend)
- Database `auction_part_2` on host port `55432`
- API `3102`, web `5102`
- Plain `pg` + ordered SQL migrations (Part 1 convention)

## Implementation slices

1. **Database-backed marketplace and user switching** — schema/seed, list auctions from Postgres, footer Active User switcher, explicit reset
2. **Post an auction** — Sell → `/auctions/new` → detail; listing fields; category art
3. **Place bids and inspect bid history** — bid rules, ended/seller guards, history

Concurrency protection remains explicitly out of scope until Part 3.
