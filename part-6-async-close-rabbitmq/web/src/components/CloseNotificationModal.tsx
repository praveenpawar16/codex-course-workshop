import { formatCurrencyFromCents } from '../types';

export type CloseNotificationView = {
  notificationId: string;
  auctionId: string;
  auctionSlug: string;
  recipientUserId: string;
  role: 'seller' | 'winner';
  outcome: 'sold' | 'unsold';
  closedAt: string;
  winnerId: string | null;
  winningAmountCents: number | null;
  sellerId: string;
};

export function CloseNotificationModal({
  notification,
  onDismiss,
  dismissing,
}: {
  notification: CloseNotificationView;
  onDismiss: () => void;
  dismissing: boolean;
}) {
  const title =
    notification.role === 'winner'
      ? 'You won this auction'
      : notification.outcome === 'unsold'
        ? 'Your auction closed unsold'
        : 'Your auction closed';

  const detail =
    notification.role === 'winner'
      ? `Winning amount ${
          notification.winningAmountCents != null
            ? formatCurrencyFromCents(notification.winningAmountCents)
            : '—'
        }.`
      : notification.outcome === 'unsold'
        ? 'No accepted bids before the closing time.'
        : `Winner secured ${
            notification.winningAmountCents != null
              ? formatCurrencyFromCents(notification.winningAmountCents)
              : '—'
          }.`;

  return (
    <div className="close-modal-backdrop" role="presentation">
      <div
        className="close-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-modal-title"
        data-testid="close-notification-modal"
        data-notification-id={notification.notificationId}
        data-role={notification.role}
        data-outcome={notification.outcome}
      >
        <p className="eyebrow">Auction closed</p>
        <h2 id="close-modal-title">{title}</h2>
        <p>{detail}</p>
        <p className="close-modal-lot">
          Lot <a href={`/auctions/${encodeURIComponent(notification.auctionSlug)}`}>{notification.auctionSlug}</a>
        </p>
        <button
          type="button"
          data-testid="close-notification-dismiss"
          onClick={onDismiss}
          disabled={dismissing}
        >
          {dismissing ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}
