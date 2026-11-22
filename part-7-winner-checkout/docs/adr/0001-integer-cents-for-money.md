# Store money as integer cents

Auction and bid amounts are compared for correctness on every bid. We store Money as integer cents in PostgreSQL (and in the API) instead of floating-point dollars or unconstrained decimals so comparisons and increments stay exact and reversible only with a deliberate migration. Display formatting happens at the edges.
