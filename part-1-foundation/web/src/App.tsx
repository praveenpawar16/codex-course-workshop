import { useEffect, useState } from 'react';

import { catalog, formatCurrency } from './catalog';
import { HealthStatus } from './components/HealthStatus';
import { ProductArt } from './components/ProductArt';
import { ProductCard } from './components/ProductCard';
import { SiteHeader } from './components/SiteHeader';

const themes = [
  { id: 'market', name: 'Market', description: 'Bright & modern' },
  { id: 'heritage', name: 'Heritage', description: 'Classic auction house' },
  { id: 'afterdark', name: 'After dark', description: 'Midnight catalog' },
] as const;

type Theme = (typeof themes)[number]['id'];

function HomePage({ theme, onThemeChange }: { theme: Theme; onThemeChange: (next: Theme) => void }) {
  return (
    <main>
      <section className="hero container">
        <div className="hero-copy">
          <p className="eyebrow"><span className="live-dot" /> The equipment exchange</p>
          <h1>Good gear.<br /><em>Second chances.</em></h1>
          <p>Find the hardware that keeps big ideas moving. Every lot is tested, honestly described, and ready for its next chapter.</p>
          <a className="hero-action" href="#auctions">Explore the auctions <span aria-hidden="true">↗</span></a>
          <div className="hero-proof"><span className="proof-stars">★★★★★</span><span>Trusted by builders, labs &amp; curious people</span></div>
        </div>
        <div className="hero-feature">
          <ProductArt kind="gpu" label="Illustration of a high-performance graphics card" />
          <div className="feature-note"><span>THIS WEEK'S HEADLINER</span><strong>NVIDIA H100 SXM 80GB</strong><small>Current bid {formatCurrency(catalog[0].currentPrice)}</small></div>
          <span className="feature-stamp">LOT<br />001</span>
        </div>
      </section>

      <section className="theme-section container" aria-labelledby="theme-heading">
        <div className="theme-intro"><div><p className="eyebrow">Make it yours</p><h2 id="theme-heading">Choose your auction house</h2></div><p>Three moods. Same six exceptional lots.</p></div>
        <div className="theme-picker" role="group" aria-label="Choose a site theme">
          {themes.map((option) => (
            <button key={option.id} type="button" className={`theme-option ${theme === option.id ? 'is-selected' : ''}`} aria-pressed={theme === option.id} onClick={() => onThemeChange(option.id)}>
              <span className={`theme-swatch swatch-${option.id}`} aria-hidden="true"><i /><i /><i /></span>
              <span className="theme-label"><strong>{option.name}</strong><small>{option.description}</small></span>
              <span className="theme-check" aria-hidden="true">✓</span>
            </button>
          ))}
        </div>
      </section>

      <section className="catalog-section container" id="auctions">
        <div className="section-heading"><div><p className="eyebrow">The current collection · 06 lots</p><h2>Worth a closer look</h2></div><span className="collection-note">Bidding is open <span className="live-dot" /></span></div>
        <div className="product-grid">{catalog.map((item) => <ProductCard key={item.slug} item={item} />)}</div>
      </section>
    </main>
  );
}

function ItemPage({ slug }: { slug: string }) {
  const item = catalog.find((candidate) => candidate.slug === slug);
  if (!item) return <main className="container empty-state"><p className="eyebrow">Lot not found</p><h1>This lot has left the building.</h1><a href="/">Return to the auction house</a></main>;

  return (
    <main className="item-page container">
      <div className="breadcrumbs"><a href="/">Auction House</a><span>/</span><span>{item.category}</span><span>/</span><span>{item.title}</span></div>
      <div className="item-layout">
        <div className="item-gallery"><ProductArt kind={item.art} label={`Illustration of ${item.title}`} /><div className="gallery-caption"><span>LOT {String(catalog.indexOf(item) + 1).padStart(3, '0')}</span><span>Condition checked · Seller verified</span></div></div>
        <section className="item-summary"><p className="product-category">{item.category} <span>·</span> {item.condition}</p><h1>{item.title}</h1><p className="item-kicker">{item.kicker}</p>
          <div className="auction-panel"><div className="current-price"><span>Current bid</span><strong>{formatCurrency(item.currentPrice)}</strong><small>{item.bidCount} bids so far</small></div><div className="bidder"><span>Leading bidder</span><strong>{item.currentBidder}</strong></div><div className="ending"><span>Auction closes in</span><strong>{item.timeLeft}</strong></div><form className="bid-form" onSubmit={(event) => event.preventDefault()}><label htmlFor="bid">Your maximum bid</label><div><span>$</span><input id="bid" inputMode="decimal" placeholder={String(item.currentPrice + 100)} /><button type="submit">Place a bid <span aria-hidden="true">↗</span></button></div><small>You'll only pay what's needed to win.</small></form></div>
          <div className="seller-card"><span className="seller-avatar">{item.seller.charAt(0)}</span><div><small>Offered by</small><strong>{item.seller}</strong><span>{item.sellerRating} <b>·</b> {item.location}</span></div><span className="verified-mark" aria-label="Verified seller">✓</span></div>
        </section>
      </div>
      <div className="item-details-grid"><section><p className="eyebrow">A little more about it</p><h2>The details</h2><p>{item.description}</p></section><section className="spec-list"><p className="eyebrow">Specifications</p>{item.specs.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section></div>
      <a className="back-link" href="/">← Back to all auctions</a>
    </main>
  );
}

export function App() {
  const path = window.location.pathname;
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem('auction-house-theme');
    return themes.some((option) => option.id === saved) ? saved as Theme : 'market';
  });
  useEffect(() => { window.localStorage.setItem('auction-house-theme', theme); }, [theme]);
  useEffect(() => { document.title = path.startsWith('/items/') ? `${catalog.find((item) => path.endsWith(item.slug))?.title ?? 'Auction'} · Auction House` : 'Auction House'; }, [path]);
  const page = path.startsWith('/items/')
    ? <ItemPage slug={decodeURIComponent(path.slice('/items/'.length))} />
    : <HomePage theme={theme} onThemeChange={setTheme} />;
  return <div className="app-shell" data-theme={theme}><SiteHeader />{page}<footer><div className="container"><a className="brand" href="/">Auction House</a><HealthStatus /><span>Good gear deserves another go.</span><span>© {new Date().getFullYear()} · Built for the next big thing</span></div></footer></div>;
}
