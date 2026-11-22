# Auction House (winner checkout)

Domain language for posting auctions, placing bids, live detail updates, recording the close outcome, and collecting payment from the Winner after Close. Implementation details live elsewhere.

## Language

**Auction**:
A timed offering that people can bid on while it is open. Becomes visible as soon as it is posted.
_Avoid_: Lot (UI flavor only), item, listing, AuctionItem

**Bid**:
An offer of a specific USD amount on an Auction by a Bidder, recorded with its time.
_Avoid_: Maximum bid, proxy bid, offer

**User**:
One of a fixed set of seeded demo people who can act as Seller or Bidder via the footer switcher. Not a real authenticated account.
_Avoid_: Account, login, session (as security)

**Seller**:
The User who posted the Auction. Taken from the active User at post time. A Seller cannot Bid on their own Auction.
_Avoid_: Owner (as a login identity)

**Bidder**:
The User who places a Bid. Taken from the active User at bid time.
_Avoid_: Buyer (unless used as casual copy)

**Active User**:
The demo User currently acting in this browser tab. Chosen at random when a tab has no saved selection, kept in sessionStorage for that tab, and changeable via the footer switcher. Shown by name at the top right.
_Avoid_: Signed-in user, authenticated account

**Starting price**:
The opening USD amount of an Auction before any Bid is accepted.
_Avoid_: Reserve price, floor

**Current amount**:
The highest accepted Bid on an Auction; equals the starting price until the first Bid is accepted.
_Avoid_: Price, valuation (as synonyms for the live high bid)

**Minimum bid**:
The least acceptable next Bid: at least one USD dollar above the current amount, enforced by the API.
_Avoid_: Soft suggestion, client-only check

**Open**:
An Auction whose Closing time is still strictly in the future and therefore may accept Bids (subject to the Seller rule).
_Avoid_: Draft, scheduled

**Ended**:
An Auction at or past its Closing time; bidding is disabled in the UI and rejected by the API. Ended is the bidding cutoff only; it does not by itself mean the final outcome has been recorded.
_Avoid_: Closed (as a synonym), Cancelled, completed checkout

**Closed**:
An Auction whose final outcome has been durably recorded after it Ended. Closed is written by the close workflow, not by the wall clock alone.
_Avoid_: Ended (as a synonym), Settled (unless used as casual copy), Completed checkout

**Closing time**:
The UTC instant at which the Auction stops accepting Bids; a Bid at or after this instant is rejected. This deadline remains the authoritative bidding cutoff.
_Avoid_: Soft end, sliding end (out of scope here)

**Winner**:
The Bidder of the highest accepted Bid on a Closed Auction that received at least one Bid.
_Avoid_: Buyer (as the close-role name), champion

**Winning amount**:
The accepted Bid amount that made the Winner the high Bidder when the Auction Closed.
_Avoid_: Current amount (after Close, prefer Winning amount), hammer price

**Unsold**:
The final outcome of a Closed Auction that received no accepted Bids. There is no Winner and no Winning amount.
_Avoid_: Failed auction, void, cancelled

**Close notification**:
A person-targeted notice that an Auction has Closed, delivered to the Seller and—when there is a Winner—to that Winner. Requires explicit dismissal in the UI.
_Avoid_: Toast-only flash, auction-changed (bid fan-out), email/SMS

**Stale bid**:
A Bid amount that may have looked valid when the Bidder submitted it, but is below the Minimum bid once acceptance is decided under contention.
_Avoid_: Lost bid, failed bid (as synonyms), automatic retry

**Auction-changed notification**:
A small realtime signal that an Auction's authoritative state may have changed after an accepted Bid commits. Clients fetch truth over HTTP.
_Avoid_: Full bid payload over the socket, push of money amounts, Close notification

**Auction room**:
The Socket.IO room for watchers of one Auction detail page, keyed by Auction slug.
_Avoid_: Global broadcast, catalog subscription, user-targeted Close notification channel

**Category**:
A fixed classification for an Auction that also selects its illustration. No user image uploads.
_Avoid_: Photo, attachment

**Specification**:
An optional detail line on an Auction. New posts may omit specifications; when none exist, the section is hidden.
_Avoid_: Required attribute set

**Money**:
USD amounts stored as integer cents for persistence and compared exactly.
_Avoid_: Floating-point dollars in storage

**Purchase**:
The server-owned payable obligation for one Closed Auction that has a Winner. Its amount is taken from the recorded Winning amount; clients do not choose the price.
_Avoid_: Order, invoice, cart, buyer-entered amount

**Paid**:
The Purchase state after Auction House has accepted a valid signed payment webhook for that Purchase. Redirects and mock UI success alone do not make a Purchase Paid.
_Avoid_: Settled (as a synonym here), captured, charged (as UI-only wording)

**Checkout**:
The Winner-started flow that opens a payment session against the local Stripe-shaped mock and returns the Winner to Auction House afterward.
_Avoid_: Real Stripe account setup, API-key configuration, Buyer (use Winner)
