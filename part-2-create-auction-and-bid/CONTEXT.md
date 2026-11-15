# Auction House (create & bid)

Domain language for posting auctions and placing bids. Implementation details live elsewhere.

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
An Auction whose closing time is still in the future and therefore may accept Bids (subject to the Seller rule).
_Avoid_: Draft, scheduled

**Ended**:
An Auction whose closing time has passed; bidding is disabled in the UI and rejected by the API.
_Avoid_: Cancelled, completed checkout (out of scope here)

**Closing time**:
The future moment the Auction stops accepting Bids, stored as a UTC timestamp.
_Avoid_: Soft end, sliding end (out of scope here)

**Category**:
A fixed classification for an Auction that also selects its illustration. No user image uploads.
_Avoid_: Photo, attachment

**Specification**:
An optional detail line on an Auction. New posts may omit specifications; when none exist, the section is hidden.
_Avoid_: Required attribute set

**Money**:
USD amounts stored as integer cents for persistence and compared exactly.
_Avoid_: Floating-point dollars in storage
