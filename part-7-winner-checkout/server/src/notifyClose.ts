import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import type { AuctionClosedPayload } from './closeAuction.js';

export type CloseNotificationRole = 'seller' | 'winner';

export type CloseNotificationRecipient = {
  userId: string;
  role: CloseNotificationRole;
};

export type CloseNotificationRecord = {
  id: string;
  auction_id: string;
  recipient_user_id: string;
  role: CloseNotificationRole;
  payload: CloseNotificationPayload;
  created_at: Date;
  emitted_at: Date | null;
  dismissed_at: Date | null;
};

export type CloseNotificationPayload = {
  notificationId: string;
  auctionId: string;
  auctionSlug: string;
  recipientUserId: string;
  role: CloseNotificationRole;
  outcome: 'sold' | 'unsold';
  closedAt: string;
  winnerId: string | null;
  winningAmountCents: number | null;
  sellerId: string;
};

/** Seller always; Winner only when the auction sold. */
export function recipientsForClose(payload: AuctionClosedPayload): CloseNotificationRecipient[] {
  const recipients: CloseNotificationRecipient[] = [
    { userId: payload.sellerId, role: 'seller' },
  ];
  if (payload.outcome === 'sold' && payload.winnerId) {
    if (payload.winnerId !== payload.sellerId) {
      recipients.push({ userId: payload.winnerId, role: 'winner' });
    }
  }
  return recipients;
}

export function buildNotificationPayload(
  notificationId: string,
  recipient: CloseNotificationRecipient,
  closed: AuctionClosedPayload
): CloseNotificationPayload {
  return {
    notificationId,
    auctionId: closed.auctionId,
    auctionSlug: closed.auctionSlug,
    recipientUserId: recipient.userId,
    role: recipient.role,
    outcome: closed.outcome,
    closedAt: closed.closedAt,
    winnerId: closed.winnerId,
    winningAmountCents: closed.winningAmountCents,
    sellerId: closed.sellerId,
  };
}

/**
 * Ensure one notification row per recipient. Returns rows still needing emit
 * (handles redelivery after insert-but-before-emit crashes).
 */
export async function ensureCloseNotifications(
  pool: pg.Pool | pg.PoolClient,
  closed: AuctionClosedPayload
): Promise<CloseNotificationRecord[]> {
  const recipients = recipientsForClose(closed);

  for (const recipient of recipients) {
    const id = randomUUID();
    const payload = buildNotificationPayload(id, recipient, closed);
    await pool.query(
      `INSERT INTO close_notifications (
         id, auction_id, recipient_user_id, role, payload
       ) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (auction_id, recipient_user_id) DO NOTHING`,
      [id, closed.auctionId, recipient.userId, recipient.role, JSON.stringify(payload)]
    );
  }

  const pending = await pool.query<CloseNotificationRecord>(
    `SELECT id, auction_id, recipient_user_id, role, payload, created_at, emitted_at, dismissed_at
     FROM close_notifications
     WHERE auction_id = $1
       AND emitted_at IS NULL
     ORDER BY created_at ASC`,
    [closed.auctionId]
  );
  return pending.rows;
}

export async function markCloseNotificationEmitted(
  pool: pg.Pool | pg.PoolClient,
  notificationId: string,
  emittedAt: Date = new Date()
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE close_notifications
     SET emitted_at = $2
     WHERE id = $1
       AND emitted_at IS NULL`,
    [notificationId, emittedAt.toISOString()]
  );
  return result.rowCount === 1;
}

export async function listUndismissedCloseNotifications(
  pool: pg.Pool | pg.PoolClient,
  recipientUserId: string
): Promise<CloseNotificationRecord[]> {
  const result = await pool.query<CloseNotificationRecord>(
    `SELECT id, auction_id, recipient_user_id, role, payload, created_at, emitted_at, dismissed_at
     FROM close_notifications
     WHERE recipient_user_id = $1
       AND dismissed_at IS NULL
     ORDER BY created_at ASC`,
    [recipientUserId]
  );
  return result.rows;
}

export async function dismissCloseNotification(
  pool: pg.Pool | pg.PoolClient,
  notificationId: string,
  recipientUserId: string,
  dismissedAt: Date = new Date()
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE close_notifications
     SET dismissed_at = $3
     WHERE id = $1
       AND recipient_user_id = $2
       AND dismissed_at IS NULL`,
    [notificationId, recipientUserId, dismissedAt.toISOString()]
  );
  return result.rowCount === 1;
}

export type DeliverCloseNotificationsResult = {
  recipients: CloseNotificationRecipient[];
  emitted: CloseNotificationPayload[];
  skippedAlreadyEmitted: number;
};

/**
 * Idempotent delivery: insert unique recipient rows, emit only those not yet
 * marked emitted, then mark emitted. Safe under RabbitMQ redelivery.
 */
export async function deliverCloseNotifications(
  pool: pg.Pool,
  closed: AuctionClosedPayload,
  emit: (payload: CloseNotificationPayload) => Promise<void>
): Promise<DeliverCloseNotificationsResult> {
  const recipients = recipientsForClose(closed);
  const pendingBefore = await ensureCloseNotifications(pool, closed);
  const emitted: CloseNotificationPayload[] = [];

  for (const row of pendingBefore) {
    const payload = row.payload;
    await emit(payload);
    const marked = await markCloseNotificationEmitted(pool, row.id);
    if (marked) {
      emitted.push(payload);
    }
  }

  const all = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM close_notifications WHERE auction_id = $1`,
    [closed.auctionId]
  );
  const skippedAlreadyEmitted = Math.max(0, (all.rows[0]?.count ?? 0) - emitted.length);

  return { recipients, emitted, skippedAlreadyEmitted };
}
