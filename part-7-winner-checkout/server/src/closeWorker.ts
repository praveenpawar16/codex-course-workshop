import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  closeDueAuctions,
  listUnpublishedCloseOutbox,
  markCloseOutboxPublished,
  type CloseClock,
} from './closeAuction.js';
import { connectRabbitPublisher, type RabbitPublisher } from './rabbitmq.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';
const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://auction:auction@127.0.0.1:5607';
const pollIntervalMs = Number(process.env.CLOSE_WORKER_POLL_MS ?? '1000');
const batchSize = Number(process.env.CLOSE_WORKER_BATCH_SIZE ?? '10');

export type CloseWorkerOptions = {
  pool?: pg.Pool;
  publisher?: RabbitPublisher;
  now?: CloseClock;
  pollIntervalMs?: number;
  batchSize?: number;
  runOnce?: boolean;
  logger?: Pick<Console, 'info' | 'error'>;
};

export async function publishUnpublishedOutbox(
  pool: pg.Pool,
  publisher: RabbitPublisher,
  limit = 50
): Promise<number> {
  const rows = await listUnpublishedCloseOutbox(pool, limit);
  let published = 0;
  for (const row of rows) {
    await publisher.publishAuctionClosed(row.payload);
    const marked = await markCloseOutboxPublished(pool, row.id);
    if (marked) published += 1;
  }
  return published;
}

export async function runCloseWorkerTick(
  pool: pg.Pool,
  publisher: RabbitPublisher,
  options: { now?: CloseClock; batchSize?: number } = {}
): Promise<{ closed: number; published: number }> {
  const closed = await closeDueAuctions(pool, {
    now: options.now,
    limit: options.batchSize ?? batchSize,
  });
  const published = await publishUnpublishedOutbox(pool, publisher);
  return { closed: closed.length, published };
}

export async function startCloseWorker(options: CloseWorkerOptions = {}): Promise<{
  stop: () => Promise<void>;
}> {
  const logger = options.logger ?? console;
  const pool = options.pool ?? new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  const ownsPool = !options.pool;
  const publisher =
    options.publisher ?? (await connectRabbitPublisher(rabbitUrl, { logger }));
  const ownsPublisher = !options.publisher;
  const interval = options.pollIntervalMs ?? pollIntervalMs;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const result = await runCloseWorkerTick(pool, publisher, {
        now: options.now,
        batchSize: options.batchSize ?? batchSize,
      });
      if (result.closed > 0 || result.published > 0) {
        logger.info(
          `close-worker closed=${result.closed} published=${result.published}`
        );
      }
    } catch (error) {
      logger.error(error);
    } finally {
      ticking = false;
    }
  }

  await tick();

  if (options.runOnce) {
    return {
      async stop() {
        stopped = true;
        if (ownsPublisher) await publisher.close();
        if (ownsPool) await pool.end();
      },
    };
  }

  timer = setInterval(() => {
    void tick();
  }, interval);

  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (ownsPublisher) await publisher.close();
      if (ownsPool) await pool.end();
    },
  };
}

const isMain =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const worker = await startCloseWorker();
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  console.info(`close-worker polling every ${pollIntervalMs}ms`);
}
