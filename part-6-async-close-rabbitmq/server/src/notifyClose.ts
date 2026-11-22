import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type pg from 'pg';

import type { AuctionClosedPayload } from './closeAuction.js';
import { createDb, type Db } from './db/client.js';
import { closeNotifications } from './db/schema.js';

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

function asDb(pool: pg.Pool | pg.PoolClient): Db {
  return createDb(pool);
}

/**
 * Ensure one notification row per recipient. Returns rows still needing emit
 * (handles redelivery after insert-but-before-emit crashes).
 */
export async function ensureCloseNotifications(
  pool: pg.Pool | pg.PoolClient,
  closed: AuctionClosedPayload
): Promise<CloseNotificationRecord[]> {
  const db = asDb(pool);
  const recipients = recipientsForClose(closed);

  for (const recipient of recipients) {
    const id = randomUUID();
    const payload = buildNotificationPayload(id, recipient, closed);
    await db
      .insert(closeNotifications)
      .values({
        id,
        auctionId: closed.auctionId,
        recipientUserId: recipient.userId,
        role: recipient.role,
        payload,
      })
      .onConflictDoNothing({
        target: [closeNotifications.auctionId, closeNotifications.recipientUserId],
      });
  }

  const pending = await db
    .select()
    .from(closeNotifications)
    .where(
      and(eq(closeNotifications.auctionId, closed.auctionId), isNull(closeNotifications.emittedAt))
    )
    .orderBy(asc(closeNotifications.createdAt));

  return pending.map((row) => ({
    id: row.id,
    auction_id: row.auctionId,
    recipient_user_id: row.recipientUserId,
    role: row.role as CloseNotificationRole,
    payload: row.payload as CloseNotificationPayload,
    created_at: row.createdAt,
    emitted_at: row.emittedAt,
    dismissed_at: row.dismissedAt,
  }));
}

export async function markCloseNotificationEmitted(
  pool: pg.Pool | pg.PoolClient,
  notificationId: string,
  emittedAt: Date = new Date()
): Promise<boolean> {
  const db = asDb(pool);
  const updated = await db
    .update(closeNotifications)
    .set({ emittedAt })
    .where(
      and(eq(closeNotifications.id, notificationId), isNull(closeNotifications.emittedAt))
    )
    .returning({ id: closeNotifications.id });
  return updated.length === 1;
}

export async function listUndismissedCloseNotifications(
  pool: pg.Pool | pg.PoolClient,
  recipientUserId: string
): Promise<CloseNotificationRecord[]> {
  const db = asDb(pool);
  const rows = await db
    .select()
    .from(closeNotifications)
    .where(
      and(
        eq(closeNotifications.recipientUserId, recipientUserId),
        isNull(closeNotifications.dismissedAt)
      )
    )
    .orderBy(asc(closeNotifications.createdAt));

  return rows.map((row) => ({
    id: row.id,
    auction_id: row.auctionId,
    recipient_user_id: row.recipientUserId,
    role: row.role as CloseNotificationRole,
    payload: row.payload as CloseNotificationPayload,
    created_at: row.createdAt,
    emitted_at: row.emittedAt,
    dismissed_at: row.dismissedAt,
  }));
}

export async function dismissCloseNotification(
  pool: pg.Pool | pg.PoolClient,
  notificationId: string,
  recipientUserId: string,
  dismissedAt: Date = new Date()
): Promise<boolean> {
  const db = asDb(pool);
  const updated = await db
    .update(closeNotifications)
    .set({ dismissedAt })
    .where(
      and(
        eq(closeNotifications.id, notificationId),
        eq(closeNotifications.recipientUserId, recipientUserId),
        isNull(closeNotifications.dismissedAt)
      )
    )
    .returning({ id: closeNotifications.id });
  return updated.length === 1;
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
  const db = asDb(pool);
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

  const [{ value: total = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(closeNotifications)
    .where(eq(closeNotifications.auctionId, closed.auctionId));

  const skippedAlreadyEmitted = Math.max(0, Number(total) - emitted.length);

  return { recipients, emitted, skippedAlreadyEmitted };
}
