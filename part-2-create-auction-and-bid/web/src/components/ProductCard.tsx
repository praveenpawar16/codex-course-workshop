import type { Auction } from '../types';
import { formatCurrencyFromCents } from '../types';
import { ProductArt } from './ProductArt';

export function ProductCard({ auction }: { auction: Auction }) {
  return (
    <article className="product-card">
      <a className="product-image-link" href={`/auctions/${auction.slug}`}>
        <ProductArt kind={auction.art} label={`Illustration of ${auction.title}`} />
        <span className="time-pill">{auction.timeLeft} left</span>
      </a>
      <div className="product-card-body">
        <p className="product-category">{auction.category}</p>
        <h3>
          <a href={`/auctions/${auction.slug}`}>{auction.title}</a>
        </h3>
        <p className="product-kicker">{auction.kicker}</p>
        <div className="price-row">
          <strong>{formatCurrencyFromCents(auction.currentAmountCents)}</strong>
          <span>{auction.bidCount} bids</span>
        </div>
      </div>
    </article>
  );
}
