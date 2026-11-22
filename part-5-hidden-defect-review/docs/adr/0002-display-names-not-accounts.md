# Demo users with a footer switcher, not real authentication

Part 2 needs a Seller and Bidder on every write without building auth. We seed ten demo Users. Each new browser tab randomly assigns an Active User and stores that choice in sessionStorage so navigation and reloads in the same tab stay stable; the footer switcher can still change it, and the header shows the active name. The Active User becomes the Seller when posting and the Bidder when bidding; Sellers cannot bid on their own Auctions. Real authentication replaces this later.
