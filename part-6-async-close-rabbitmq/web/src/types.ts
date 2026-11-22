export type ProductArtKind = 'gpu' | 'cpu' | 'memory' | 'chassis' | 'switch' | 'cooling';

export type DemoUser = {
  id: string;
  handle: string;
  displayName: string;
};

export type Bid = {
  id: string;
  amountCents: number;
  createdAt: string;
  bidder: DemoUser;
};

export type AuctionOutcome = 'sold' | 'unsold';

export type Auction = {
  id: string;
  slug: string;
  title: string;
  kicker: string;
  category: string;
  art: ProductArtKind;
  description: string;
  condition: string;
  location: string;
  startingPriceCents: number;
  currentAmountCents: number;
  bidCount: number;
  closingTime: string;
  timeLeft: string;
  ended: boolean;
  closed: boolean;
  closedAt: string | null;
  outcome: AuctionOutcome | null;
  winningAmountCents: number | null;
  minimumBidCents: number;
  specifications: Array<[string, string]>;
  seller: DemoUser;
  leadingBidder: DemoUser | null;
  winner: DemoUser | null;
};

export function formatCurrencyFromCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isFinite(cents) ? cents : null;
}
