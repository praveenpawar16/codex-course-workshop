import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient, type RedisClientType } from 'redis';

import { AUCTION_CLOSED_EVENT, type AuctionClosedPayload } from './closeAuction.js';
import { CLOSE_NOTIFICATION_CHANNEL } from './closeNotificationBus.js';
import { deliverCloseNotifications } from './notifyClose.js';
import { connectAuctionCloseConsumer } from './rabbitmqConsumer.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';
const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://auction:auction@127.0.0.1:5607';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6307';

function isAuctionClosedPayload(value: unknown): value is AuctionClosedPayload {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    row.eventType === AUCTION_CLOSED_EVENT &&
    typeof row.auctionId === 'string' &&
    typeof row.auctionSlug === 'string' &&
    typeof row.sellerId === 'string' &&
    typeof row.closedAt === 'string' &&
    (row.outcome === 'sold' || row.outcome === 'unsold')
  );
}

export type NotificationWorkerOptions = {
  pool?: pg.Pool;
  redisUrl?: string;
  rabbitUrl?: string;
  publishCloseNotification?: (payload: unknown) => Promise<void>;
  logger?: Pick<Console, 'info' | 'error'>;
};

export async function processAuctionClosedMessage(
  pool: pg.Pool,
  payload: AuctionClosedPayload,
  publishCloseNotification: (payload: unknown) => Promise<void>
) {
  return deliverCloseNotifications(pool, payload, async (notification) => {
    await publishCloseNotification(notification);
  });
}

export async function startNotificationWorker(options: NotificationWorkerOptions = {}): Promise<{
  stop: () => Promise<void>;
  processMessage: (
    payload: AuctionClosedPayload
  ) => ReturnType<typeof processAuctionClosedMessage>;
}> {
  const logger = options.logger ?? console;
  const pool = options.pool ?? new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  const ownsPool = !options.pool;

  let redisPublisher: RedisClientType | undefined;
  let publishCloseNotification = options.publishCloseNotification;

  if (!publishCloseNotification) {
    redisPublisher = createClient({ url: options.redisUrl ?? redisUrl });
    redisPublisher.on('error', (error) => {
      logger.error({ err: error });
    });
    await redisPublisher.connect();
    publishCloseNotification = async (payload: unknown) => {
      await redisPublisher!.publish(CLOSE_NOTIFICATION_CHANNEL, JSON.stringify(payload));
    };
  }

  const processMessage = (payload: AuctionClosedPayload) =>
    processAuctionClosedMessage(pool, payload, publishCloseNotification!);

  const consumer = await connectAuctionCloseConsumer(
    options.rabbitUrl ?? rabbitUrl,
    async (raw) => {
      if (!isAuctionClosedPayload(raw)) {
        throw new Error('Invalid auction.closed payload');
      }
      const result = await processMessage(raw);
      logger.info(
        `notification-worker auction=${raw.auctionSlug} emitted=${result.emitted.length} recipients=${result.recipients.length}`
      );
    },
    { logger }
  );

  return {
    processMessage,
    async stop() {
      await consumer.close();
      if (redisPublisher) await redisPublisher.quit().catch(() => undefined);
      if (ownsPool) await pool.end();
    },
  };
}

const isMain =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const worker = await startNotificationWorker();
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  console.info('notification-worker consuming auction.close');
}
