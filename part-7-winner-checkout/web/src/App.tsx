import { useEffect, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';

import { ActiveUserProvider, useActiveUser } from './activeUser';
import {
  CloseNotificationModal,
  type CloseNotificationView,
} from './components/CloseNotificationModal';
import { HealthStatus } from './components/HealthStatus';
import { ProductArt } from './components/ProductArt';
import { ProductCard } from './components/ProductCard';
import { SiteHeader } from './components/SiteHeader';
import { UserSwitcher } from './components/UserSwitcher';
import { NewAuctionPage } from './pages/NewAuctionPage';
import type { Auction, Bid } from './types';
import { dollarsToCents, formatCurrencyFromCents } from './types';

type AuctionChangedPayload = {
  auctionSlug: string;
  reason?: string;
};

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

function formatLiveCountdown(closingTime: string, nowMs: number): { label: string; ended: boolean } {
  const remaining = new Date(closingTime).getTime() - nowMs;
  if (remaining <= 0) return { label: 'ENDED', ended: true };
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return { label: `${minutes}m ${String(seconds).padStart(2, '0')}s`, ended: false };
  return { label: `${seconds}s`, ended: false };
}

function ItemPage({ slug }: { slug: string }) {
  const [auction, setAuction] = useState<Auction | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [bidAmount, setBidAmount] = useState('');
  const [bidError, setBidError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutStarting, setCheckoutStarting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activity, setActivity] = useState<string[]>([]);
  const { activeUser } = useActiveUser();

  function pushActivity(line: string) {
    const stamp = new Date().toLocaleTimeString();
    setActivity((current) => [`${stamp} · ${line}`, ...current].slice(0, 12));
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!auction || auction.closed) return;
    const closingMs = Date.parse(auction.closingTime);
    const viewerQuery = activeUser
      ? `?viewerId=${encodeURIComponent(activeUser.id)}`
      : '';
    const timer = window.setInterval(() => {
      if (Date.now() < closingMs && !auction.ended) return;
      void (async () => {
        try {
          const response = await fetch(
            `/api/auctions/${encodeURIComponent(slug)}${viewerQuery}`
          );
          if (!response.ok) return;
          const body = (await response.json()) as { auction: Auction; bids: Bid[] };
          setAuction(body.auction);
          setBids(body.bids ?? []);
          if (body.auction.closed) {
            pushActivity(
              body.auction.outcome === 'unsold'
                ? 'Close recorded: unsold'
                : `Close recorded: winner ${body.auction.winner?.displayName ?? 'unknown'}`
            );
          }
        } catch {
          // Ignore transient poll errors; next tick retries.
        }
      })();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [auction?.closed, auction?.ended, auction?.closingTime, slug, activeUser?.id]);

  useEffect(() => {
    const controller = new AbortController();
    let seenBidIds = new Set<string>();
    let socket: Socket | null = null;
    let hasConnectedOnce = false;

    async function loadAuction(mode: 'initial' | 'refresh') {
      try {
        const viewerQuery = activeUser
          ? `?viewerId=${encodeURIComponent(activeUser.id)}`
          : '';
        const response = await fetch(
          `/api/auctions/${encodeURIComponent(slug)}${viewerQuery}`,
          {
            signal: controller.signal,
          }
        );
        if (response.status === 404) {
          if (mode === 'initial') setMissing(true);
          return;
        }
        if (!response.ok) throw new Error('failed');
        const body = (await response.json()) as { auction: Auction; bids: Bid[] };
        setAuction(body.auction);
        const nextBids = body.bids ?? [];
        if (mode === 'refresh') {
          for (const bid of [...nextBids].reverse()) {
            if (!seenBidIds.has(bid.id)) {
              seenBidIds.add(bid.id);
              pushActivity(
                `Accepted ${formatCurrencyFromCents(bid.amountCents)} from ${bid.bidder.displayName}`
              );
            }
          }
          setBidAmount((body.auction.minimumBidCents / 100).toFixed(2));
        } else {
          seenBidIds = new Set(nextBids.map((bid) => bid.id));
          setBidAmount((body.auction.minimumBidCents / 100).toFixed(2));
        }
        setBids(nextBids);
        if (mode === 'initial') setMissing(false);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (mode === 'initial') setMissing(true);
      } finally {
        if (mode === 'initial') setLoading(false);
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      setNowMs(Date.now());
      void loadAuction('refresh');
      pushActivity('Tab active — refreshed auction state');
    }

    void loadAuction('initial');

    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socket.emit('join-auction', slug);
    socket.on('auction-changed', (payload: AuctionChangedPayload) => {
      if (payload?.auctionSlug !== slug) return;
      void loadAuction('refresh');
    });
    socket.on('connect', () => {
      socket?.emit('join-auction', slug);
      if (hasConnectedOnce) {
        pushActivity('Reconnected — refreshed auction state');
        void loadAuction('refresh');
      }
      hasConnectedOnce = true;
    });

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (socket) {
        socket.emit('leave-auction', slug);
        socket.removeAllListeners();
        socket.disconnect();
      }
    };
  }, [slug, activeUser?.id]);

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

  const countdown = formatLiveCountdown(auction.closingTime, nowMs);
  const ended = countdown.ended || auction.ended;
  const closed = auction.closed;
  const isSeller = Boolean(activeUser && activeUser.id === auction.seller.id);
  const isWinner = Boolean(activeUser && auction.winner && activeUser.id === auction.winner.id);
  const canBid = Boolean(activeUser) && !ended && !isSeller;
  const canCheckout =
    Boolean(activeUser) &&
    closed &&
    auction.outcome === 'sold' &&
    isWinner &&
    auction.purchase?.status !== 'paid';
  const checkoutQuery = new URLSearchParams(window.location.search).get('checkout');
  const bidBlockedReason = ended
    ? closed
      ? auction.outcome === 'unsold'
        ? 'This auction closed unsold. Bidding is closed.'
        : 'This auction has closed. Bidding is closed.'
      : 'This auction has ended. Waiting for the final close outcome…'
    : isSeller
      ? 'You are the seller. Bidding is unavailable on your own auction.'
      : !activeUser
        ? 'Choose an active user in the footer to bid.'
        : null;

  async function onStartCheckout() {
    if (!auction || !activeUser || !canCheckout || checkoutStarting) return;
    setCheckoutError(null);
    setCheckoutStarting(true);
    pushActivity('Starting checkout…');
    try {
      const response = await fetch(`/api/auctions/${encodeURIComponent(auction.slug)}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: activeUser.id }),
      });
      const body = (await response.json()) as {
        checkoutUrl?: string | null;
        auction?: Auction;
        error?: string;
      };
      if (!response.ok) {
        setCheckoutError(body.error ?? 'Could not start checkout.');
        pushActivity(`Checkout rejected: ${body.error ?? 'Could not start checkout.'}`);
        return;
      }
      if (body.auction) setAuction(body.auction);
      if (body.auction?.purchase?.status === 'paid') {
        pushActivity('Purchase already paid');
        return;
      }
      if (!body.checkoutUrl) {
        setCheckoutError('Checkout URL missing.');
        return;
      }
      window.location.assign(body.checkoutUrl);
    } catch {
      setCheckoutError('Could not start checkout.');
      pushActivity('Network error while starting checkout');
    } finally {
      setCheckoutStarting(false);
    }
  }

  async function onPlaceBid(event: FormEvent) {
    event.preventDefault();
    if (!auction || !activeUser || !canBid) return;
    setBidError(null);

    const amountCents = dollarsToCents(bidAmount);
    if (amountCents === null) {
      setBidError('Enter a valid dollar amount like 101.00.');
      return;
    }

    pushActivity(`Submitting ${formatCurrencyFromCents(amountCents)} as ${activeUser.displayName}`);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/auctions/${encodeURIComponent(auction.slug)}/bids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidderId: activeUser.id, amountCents }),
      });
      const body = (await response.json()) as {
        auction?: Auction;
        bids?: Bid[];
        error?: string;
        minimumBidCents?: number;
      };
      if (!response.ok) {
        setBidError(body.error ?? 'Could not place bid.');
        pushActivity(`Rejected: ${body.error ?? 'Could not place bid.'}`);
        // Stale bid: refresh board from the locked/validated server state; do not resubmit.
        if (body.auction) {
          setAuction(body.auction);
          setBids(body.bids ?? []);
          setBidAmount((body.auction.minimumBidCents / 100).toFixed(2));
        } else if (body.minimumBidCents) {
          setBidAmount((body.minimumBidCents / 100).toFixed(2));
        }
        return;
      }
      if (!body.auction) {
        setBidError('Could not place bid.');
        return;
      }
      setAuction(body.auction);
      setBids(body.bids ?? []);
      setBidAmount((body.auction.minimumBidCents / 100).toFixed(2));
      pushActivity(`Server accepted ${formatCurrencyFromCents(amountCents)}`);
    } catch {
      setBidError('Could not place bid.');
      pushActivity('Network error while placing bid');
    } finally {
      setSubmitting(false);
    }
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
              <span>{closed ? 'Auction closed' : ended ? 'Auction ended' : 'Auction closes in'}</span>
              <strong data-testid="auction-countdown">
                {closed
                  ? auction.outcome === 'unsold'
                    ? 'UNSOLD'
                    : 'CLOSED'
                  : countdown.label}
              </strong>
            </div>
            {closed ? (
              <div className="close-outcome" data-testid="auction-close-outcome">
                {auction.outcome === 'unsold' ? (
                  <>
                    <span>Final outcome</span>
                    <strong>Unsold</strong>
                    <small>No accepted bids before the closing time.</small>
                  </>
                ) : (
                  <>
                    <span>Winner</span>
                    <strong>{auction.winner?.displayName ?? '—'}</strong>
                    <small>
                      Winning amount{' '}
                      {auction.winningAmountCents != null
                        ? formatCurrencyFromCents(auction.winningAmountCents)
                        : '—'}
                    </small>
                  </>
                )}
              </div>
            ) : null}
            {closed && auction.outcome === 'sold' && auction.purchase ? (
              <div className="purchase-panel" data-testid="purchase-panel">
                <span>Purchase</span>
                <strong data-testid="purchase-status">
                  {auction.purchase.status === 'paid' ? 'Paid' : 'Unpaid'}
                </strong>
                <small>
                  {formatCurrencyFromCents(auction.purchase.amountCents)}
                  {isWinner ? ' · you are the winner' : null}
                  {isSeller ? ' · you are the seller' : null}
                </small>
                {isSeller && auction.purchase.status === 'unpaid' ? (
                  <p className="purchase-hint" data-testid="seller-recovery-hint">
                    Waiting for the winner to pay. They can retry checkout anytime — including
                    after a dropped mock payment session.
                  </p>
                ) : null}
                {isSeller && auction.purchase.status === 'paid' ? (
                  <p className="form-success" role="status" data-testid="seller-paid-hint">
                    Winner payment received.
                  </p>
                ) : null}
                {checkoutQuery === 'success' && auction.purchase.status === 'paid' ? (
                  <p className="form-success" role="status">
                    Payment confirmed.
                  </p>
                ) : null}
                {checkoutQuery === 'canceled' && auction.purchase.status !== 'paid' && isWinner ? (
                  <p className="form-error" role="status">
                    Checkout canceled. You can try again when ready.
                  </p>
                ) : null}
                {canCheckout ? (
                  <button
                    type="button"
                    className="checkout-action"
                    data-testid="complete-purchase"
                    disabled={checkoutStarting}
                    onClick={() => void onStartCheckout()}
                  >
                    {checkoutStarting ? 'Starting…' : 'Complete purchase'}
                  </button>
                ) : null}
                {checkoutError ? (
                  <p className="form-error" role="alert">
                    {checkoutError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <form className="bid-form" onSubmit={onPlaceBid}>
              <label htmlFor="bid">Your bid</label>
              <div>
                <span>$</span>
                <input
                  id="bid"
                  inputMode="decimal"
                  value={bidAmount}
                  onChange={(event) => setBidAmount(event.target.value)}
                  placeholder={(auction.minimumBidCents / 100).toFixed(2)}
                  disabled={!canBid || submitting}
                />
                <button type="submit" disabled={!canBid || submitting}>
                  {submitting ? 'Bidding…' : <>Place a bid <span aria-hidden="true">↗</span></>}
                </button>
              </div>
              <small>
                Minimum next bid: {formatCurrencyFromCents(auction.minimumBidCents)}.
                {bidBlockedReason ? ` ${bidBlockedReason}` : null}
              </small>
              {bidError ? <p className="form-error" role="alert">{bidError}</p> : null}
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
        <section className="bid-activity" aria-label="Bidding activity">
          <p className="eyebrow">Live activity</p>
          <h2>What just happened</h2>
          {activity.length === 0 ? (
            <p className="bid-history-empty">Waiting for bids…</p>
          ) : (
            <ul data-testid="bid-activity">
              {activity.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="bid-history" aria-label="Bid history">
        <p className="eyebrow">Bid history</p>
        <h2>Who has bid</h2>
        {bids.length === 0 ? (
          <p className="bid-history-empty">No bids yet.</p>
        ) : (
          <ul data-testid="bid-history-list">
            {bids.map((bid) => (
              <li key={bid.id} data-amount-cents={bid.amountCents}>
                <strong>{bid.bidder.displayName}</strong>
                <span>{formatCurrencyFromCents(bid.amountCents)}</span>
                <time dateTime={bid.createdAt}>{new Date(bid.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
      <a className="back-link" href="/">← Back to all auctions</a>
    </main>
  );
}

function AppShell() {
  const path = window.location.pathname;
  const { activeUser } = useActiveUser();
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem('auction-house-theme');
    return themes.some((option) => option.id === saved) ? saved as Theme : 'market';
  });
  const [closeNotification, setCloseNotification] = useState<CloseNotificationView | null>(null);
  const [dismissingClose, setDismissingClose] = useState(false);
  const closeNotificationRef = useRef<CloseNotificationView | null>(null);
  const seenCloseIdsRef = useRef(new Set<string>());

  function queueCloseNotification(notification: CloseNotificationView) {
    if (seenCloseIdsRef.current.has(notification.notificationId)) return;
    if (closeNotificationRef.current) return;
    seenCloseIdsRef.current.add(notification.notificationId);
    closeNotificationRef.current = notification;
    setCloseNotification(notification);
  }

  useEffect(() => {
    window.localStorage.setItem('auction-house-theme', theme);
  }, [theme]);

  useEffect(() => {
    const isDetail = path.startsWith('/items/') || (path.startsWith('/auctions/') && path !== '/auctions/new');
    document.title = path === '/auctions/new'
      ? 'Sell · Auction House'
      : isDetail
        ? 'Auction · Auction House'
        : 'Auction House';
  }, [path]);

  useEffect(() => {
    closeNotificationRef.current = null;
    setCloseNotification(null);

    if (!activeUser) return;

    let cancelled = false;
    let socket: Socket | null = null;
    const userId = activeUser.id;

    async function loadPending() {
      try {
        const response = await fetch(`/api/users/${encodeURIComponent(userId)}/close-notifications`);
        if (!response.ok) return;
        const body = (await response.json()) as { notifications: CloseNotificationView[] };
        const next = body.notifications[0];
        if (!cancelled && next) {
          queueCloseNotification({
            ...next,
            notificationId: next.notificationId,
          });
        }
      } catch {
        // Ignore; socket path remains primary.
      }
    }

    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socket.emit('join-user', userId);
    socket.on('close-notification', (payload: CloseNotificationView) => {
      if (!payload?.notificationId) return;
      if (payload.recipientUserId && payload.recipientUserId !== userId) return;
      queueCloseNotification(payload);
    });
    socket.on('connect', () => {
      socket?.emit('join-user', userId);
      void loadPending();
    });

    void loadPending();

    return () => {
      cancelled = true;
      if (socket) {
        socket.emit('leave-user', userId);
        socket.removeAllListeners();
        socket.disconnect();
      }
    };
  }, [activeUser?.id]);

  async function dismissCloseNotification() {
    const current = closeNotificationRef.current;
    if (!current || !activeUser) return;
    setDismissingClose(true);
    try {
      await fetch(`/api/close-notifications/${encodeURIComponent(current.notificationId)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: activeUser.id }),
      });
    } finally {
      closeNotificationRef.current = null;
      setCloseNotification(null);
      setDismissingClose(false);
      try {
        const response = await fetch(
          `/api/users/${encodeURIComponent(activeUser.id)}/close-notifications`
        );
        if (response.ok) {
          const body = (await response.json()) as { notifications: CloseNotificationView[] };
          const next = body.notifications.find(
            (item) => item.notificationId !== current.notificationId
          );
          if (next) queueCloseNotification(next);
        }
      } catch {
        // ignore
      }
    }
  }

  let page;
  if (path === '/auctions/new') {
    page = <NewAuctionPage />;
  } else if (path.startsWith('/auctions/')) {
    page = <ItemPage slug={decodeURIComponent(path.slice('/auctions/'.length))} />;
  } else if (path.startsWith('/items/')) {
    page = <ItemPage slug={decodeURIComponent(path.slice('/items/'.length))} />;
  } else {
    page = <HomePage theme={theme} onThemeChange={setTheme} />;
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <SiteHeader />
      {page}
      {closeNotification ? (
        <CloseNotificationModal
          notification={closeNotification}
          onDismiss={() => void dismissCloseNotification()}
          dismissing={dismissingClose}
        />
      ) : null}
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
