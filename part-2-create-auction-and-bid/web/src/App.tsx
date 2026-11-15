import { useEffect, useState } from 'react';

import { ActiveUserProvider, useActiveUser } from './activeUser';
import { HealthStatus } from './components/HealthStatus';
import { ProductArt } from './components/ProductArt';
import { ProductCard } from './components/ProductCard';
import { SiteHeader } from './components/SiteHeader';
import { UserSwitcher } from './components/UserSwitcher';
import type { Auction } from './types';
import { formatCurrencyFromCents } from './types';

const themes = [
  { id: 'market', name: 'Market', description: 'Bright & modern' },
  { id: 'heritage', name: 'Heritage', description: 'Classic auction house' },
  { id: 'afterdark', name: 'After dark', description: 'Midnight catalog' },
] as const;

type Theme = (typeof themes)[number]['id'];

function useAuctions() {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const response = await fetch('/api/auctions', { signal: controller.signal });
          if (!response.ok) throw new Error('Could not load auctions');
          const body = (await response.json()) as { auctions: Auction[] };
          setAuctions(body.auctions);
          setError(null);
          setLoading(false);
          return;
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      setError(lastError ? 'Could not load auctions from the API' : 'Could not load auctions from the API');
      setLoading(false);
    })();
    return () => controller.abort();
  }, []);

  return { auctions, loading, error };
}

function HomePage({ theme, onThemeChange }: { theme: Theme; onThemeChange: (next: Theme) => void }) {
  const { auctions, loading, error } = useAuctions();
  const headliner = auctions[0];

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
          <ProductArt kind={headliner?.art ?? 'gpu'} label="Illustration of a high-performance graphics card" />
          <div className="feature-note">
            <span>THIS WEEK'S HEADLINER</span>
            <strong>{headliner?.title ?? 'Loading…'}</strong>
            <small>
              {headliner
                ? `Current bid ${formatCurrencyFromCents(headliner.currentAmountCents)}`
                : 'Fetching live auctions'}
            </small>
          </div>
          <span className="feature-stamp">LOT<br />001</span>
        </div>
      </section>

      <section className="theme-section container" aria-labelledby="theme-heading">
        <div className="theme-intro">
          <div>
            <p className="eyebrow">Make it yours</p>
            <h2 id="theme-heading">Choose your auction house</h2>
          </div>
          <p>Three moods. Same live collection from PostgreSQL.</p>
        </div>
        <div className="theme-picker" role="group" aria-label="Choose a site theme">
          {themes.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`theme-option ${theme === option.id ? 'is-selected' : ''}`}
              aria-pressed={theme === option.id}
              onClick={() => onThemeChange(option.id)}
            >
              <span className={`theme-swatch swatch-${option.id}`} aria-hidden="true"><i /><i /><i /></span>
              <span className="theme-label"><strong>{option.name}</strong><small>{option.description}</small></span>
              <span className="theme-check" aria-hidden="true">✓</span>
            </button>
          ))}
        </div>
      </section>

      <section className="catalog-section container" id="auctions">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              The current collection · {loading ? '…' : String(auctions.length).padStart(2, '0')} lots
            </p>
            <h2>Worth a closer look</h2>
          </div>
          <span className="collection-note">Bidding is open <span className="live-dot" /></span>
        </div>
        {error ? <p className="catalog-error">{error}</p> : null}
        {loading ? <p className="catalog-loading">Loading auctions…</p> : null}
        {!loading && !error ? (
          <div className="product-grid">
            {auctions.map((auction) => (
              <ProductCard key={auction.id} auction={auction} />
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ItemPage({ slug }: { slug: string }) {
  const [auction, setAuction] = useState<Auction | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const { activeUser } = useActiveUser();

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`/api/auctions/${encodeURIComponent(slug)}`, {
          signal: controller.signal,
        });
        if (response.status === 404) {
          setMissing(true);
          return;
        }
        if (!response.ok) throw new Error('failed');
        const body = (await response.json()) as { auction: Auction };
        setAuction(body.auction);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setMissing(true);
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [slug]);

  if (loading) {
    return <main className="container empty-state"><p className="eyebrow">Loading</p><h1>Fetching this auction…</h1></main>;
  }

  if (missing || !auction) {
    return (
      <main className="container empty-state">
        <p className="eyebrow">Auction not found</p>
        <h1>This auction has left the building.</h1>
        <a href="/">Return to the auction house</a>
      </main>
    );
  }

  return (
    <main className="item-page container">
      <div className="breadcrumbs">
        <a href="/">Auction House</a><span>/</span><span>{auction.category}</span><span>/</span><span>{auction.title}</span>
      </div>
      <div className="item-layout">
        <div className="item-gallery">
          <ProductArt kind={auction.art} label={`Illustration of ${auction.title}`} />
          <div className="gallery-caption">
            <span>{auction.slug}</span>
            <span>Condition checked · Seller verified</span>
          </div>
        </div>
        <section className="item-summary">
          <p className="product-category">{auction.category} <span>·</span> {auction.condition}</p>
          <h1>{auction.title}</h1>
          <p className="item-kicker">{auction.kicker}</p>
          <div className="auction-panel">
            <div className="current-price">
              <span>Current bid</span>
              <strong>{formatCurrencyFromCents(auction.currentAmountCents)}</strong>
              <small>{auction.bidCount} bids so far</small>
            </div>
            <div className="bidder">
              <span>Leading bidder</span>
              <strong>{auction.leadingBidder?.displayName ?? '—'}</strong>
            </div>
            <div className="ending">
              <span>Auction closes in</span>
              <strong>{auction.timeLeft}</strong>
            </div>
            <form className="bid-form" onSubmit={(event) => event.preventDefault()}>
              <label htmlFor="bid">Your maximum bid</label>
              <div>
                <span>$</span>
                <input
                  id="bid"
                  inputMode="decimal"
                  placeholder={String(auction.currentAmountCents / 100 + 1)}
                  disabled
                />
                <button type="submit" disabled>Place a bid <span aria-hidden="true">↗</span></button>
              </div>
              <small>
                Bidding arrives in Slice 3. Active user: {activeUser?.displayName ?? 'none selected'}.
              </small>
            </form>
          </div>
          <div className="seller-card">
            <span className="seller-avatar">{auction.seller.displayName.charAt(0)}</span>
            <div>
              <small>Offered by</small>
              <strong>{auction.seller.displayName}</strong>
              <span>@{auction.seller.handle} <b>·</b> {auction.location}</span>
            </div>
            <span className="verified-mark" aria-label="Verified seller">✓</span>
          </div>
        </section>
      </div>
      <div className="item-details-grid">
        <section>
          <p className="eyebrow">A little more about it</p>
          <h2>The details</h2>
          <p>{auction.description}</p>
        </section>
        {auction.specifications.length > 0 ? (
          <section className="spec-list">
            <p className="eyebrow">Specifications</p>
            {auction.specifications.map(([label, value]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong></div>
            ))}
          </section>
        ) : null}
      </div>
      <a className="back-link" href="/">← Back to all auctions</a>
    </main>
  );
}

function AppShell() {
  const path = window.location.pathname;
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem('auction-house-theme');
    return themes.some((option) => option.id === saved) ? saved as Theme : 'market';
  });

  useEffect(() => {
    window.localStorage.setItem('auction-house-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.title = path.startsWith('/items/') ? 'Auction · Auction House' : 'Auction House';
  }, [path]);

  const page = path.startsWith('/items/')
    ? <ItemPage slug={decodeURIComponent(path.slice('/items/'.length))} />
    : <HomePage theme={theme} onThemeChange={setTheme} />;

  return (
    <div className="app-shell" data-theme={theme}>
      <SiteHeader />
      {page}
      <footer>
        <div className="container footer-bar">
          <a className="brand" href="/">Auction House</a>
          <HealthStatus />
          <UserSwitcher />
          <span>Good gear deserves another go.</span>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <ActiveUserProvider>
      <AppShell />
    </ActiveUserProvider>
  );
}
