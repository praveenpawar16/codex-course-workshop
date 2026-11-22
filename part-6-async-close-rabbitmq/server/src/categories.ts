export const CATEGORY_NAMES = [
  'GPUs',
  'CPUs',
  'Memory',
  'Chassis',
  'Networking',
  'Cooling',
] as const;

export type AuctionCategory = (typeof CATEGORY_NAMES)[number];

export const AUCTION_CATEGORIES: Array<{ category: AuctionCategory; art: string }> = [
  { category: 'GPUs', art: 'gpu' },
  { category: 'CPUs', art: 'cpu' },
  { category: 'Memory', art: 'memory' },
  { category: 'Chassis', art: 'chassis' },
  { category: 'Networking', art: 'switch' },
  { category: 'Cooling', art: 'cooling' },
];

export function artForCategory(category: string): string | null {
  return AUCTION_CATEGORIES.find((entry) => entry.category === category)?.art ?? null;
}
