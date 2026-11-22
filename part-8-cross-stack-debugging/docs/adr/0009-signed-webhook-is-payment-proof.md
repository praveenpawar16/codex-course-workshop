# Signed webhook is authoritative payment proof

Winner Checkout uses a local Stripe-shaped mock. A Purchase becomes **Paid** only when Auction House accepts a valid signed `checkout.session.completed` webhook for that Purchase. Browser redirects and mock UI success are convenience only. Duplicate deliveries must be replay-safe so retries and mock redelivery cannot double-apply payment. Rejected: treating the success redirect as proof, and requiring a real Stripe account or API keys for this part.
