export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container header-main">
        <a className="brand" href="/" aria-label="Auction House home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Auction House</span>
        </a>
        <span className="header-note"><span className="live-dot" /> Six live auctions · New finds every week</span>
        <a className="header-link" href="#auctions">Explore lots <span aria-hidden="true">↓</span></a>
      </div>
    </header>
  );
}
