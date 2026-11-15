export type ProductArtKind = 'gpu' | 'cpu' | 'memory' | 'chassis' | 'switch' | 'cooling';

export type DemoUser = {
  id: string;
  handle: string;
  displayName: string;
};

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
  specifications: Array<[string, string]>;
  seller: DemoUser;
  leadingBidder: DemoUser | null;
};

export function formatCurrencyFromCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
