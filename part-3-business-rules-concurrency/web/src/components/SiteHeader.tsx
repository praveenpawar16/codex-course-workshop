import { useActiveUser } from '../activeUser';

export function SiteHeader() {
  const { activeUser, loading } = useActiveUser();
  const activeLabel = loading
    ? 'Loading user…'
    : activeUser
      ? activeUser.displayName
      : 'No active user';

  return (
    <header className="site-header">
      <div className="container header-main">
        <a className="brand" href="/" aria-label="Auction House home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Auction House</span>
        </a>
        <span className="header-note">
          <span className="live-dot" /> Six live auctions · New finds every week
        </span>
        <div className="header-actions">
          <a className="header-sell" href="/auctions/new">Sell</a>
          <div className="header-active-user" aria-label="Active demo user">
            <span className="header-active-user-label">Signed in as</span>
            <strong>{activeLabel}</strong>
          </div>
        </div>
      </div>
    </header>
  );
}
