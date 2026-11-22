import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  handle: text('handle').notNull().unique(),
  displayName: text('display_name').notNull(),
});

export const auctions = pgTable('auctions', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  kicker: text('kicker').notNull().default(''),
  category: text('category').notNull(),
  art: text('art').notNull(),
  description: text('description').notNull(),
  condition: text('condition').notNull(),
  location: text('location').notNull(),
  startingPriceCents: integer('starting_price_cents').notNull(),
  currentAmountCents: integer('current_amount_cents').notNull(),
  bidCount: integer('bid_count').notNull().default(0),
  leadingBidderId: uuid('leading_bidder_id').references(() => users.id),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => users.id),
  closingTime: timestamp('closing_time', { withTimezone: true, mode: 'date' }).notNull(),
  specifications: jsonb('specifications').$type<Array<[string, string]>>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
  winnerId: uuid('winner_id').references(() => users.id),
  winningAmountCents: integer('winning_amount_cents'),
});

export const bids = pgTable('bids', {
  id: uuid('id').primaryKey(),
  auctionId: uuid('auction_id')
    .notNull()
    .references(() => auctions.id, { onDelete: 'cascade' }),
  bidderId: uuid('bidder_id')
    .notNull()
    .references(() => users.id),
  amountCents: integer('amount_cents').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const auctionCloseOutbox = pgTable(
  'auction_close_outbox',
  {
    id: uuid('id').primaryKey(),
    auctionId: uuid('auction_id')
      .notNull()
      .references(() => auctions.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull().default('auction.closed'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('auction_close_outbox_auction_id_uidx').on(table.auctionId),
    uniqueIndex('auction_close_outbox_auction_event_uidx').on(table.auctionId, table.eventType),
  ]
);

export const closeNotifications = pgTable(
  'close_notifications',
  {
    id: uuid('id').primaryKey(),
    auctionId: uuid('auction_id')
      .notNull()
      .references(() => auctions.id, { onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    emittedAt: timestamp('emitted_at', { withTimezone: true, mode: 'date' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('close_notifications_auction_recipient_uidx').on(
      table.auctionId,
      table.recipientUserId
    ),
  ]
);
