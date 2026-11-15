import type { ProductArtKind } from './types';

export const AUCTION_CATEGORIES: Array<{ category: string; art: ProductArtKind }> = [
  { category: 'GPUs', art: 'gpu' },
  { category: 'CPUs', art: 'cpu' },
  { category: 'Memory', art: 'memory' },
  { category: 'Chassis', art: 'chassis' },
  { category: 'Networking', art: 'switch' },
  { category: 'Cooling', art: 'cooling' },
];
