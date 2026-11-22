import './otel.js';

import { createClient, type RedisClientType } from 'redis';

import { assertRedisReady, attachRealtime, type RealtimeHub } from './realtime.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6307';
const port = Number(process.env.API_PORT ?? 3107);

try {
  await assertRedisReady(redisUrl);
} catch (error) {
  console.error('Redis must be available before the application is ready:', error);
  process.exit(1);
}

const healthClient: RedisClientType = createClient({ url: redisUrl });
healthClient.on('error', () => {
  // Surfaced by ping(); avoid unhandled error events.
});
await healthClient.connect();

let realtime: RealtimeHub | undefined;
let publishAuctionChanged = async (_auctionSlug: string) => {
  // Replaced after Socket.IO attaches.
};

const { buildApp } = await import('./app.js');
const app = buildApp({
  publishAuctionChanged: (auctionSlug) => publishAuctionChanged(auctionSlug),
  checkRedis: async () => {
    try {
      return (await healthClient.ping()) === 'PONG';
    } catch {
      return false;
    }
  },
});

app.addHook('onClose', async () => {
  await realtime?.close();
  await healthClient.quit().catch(() => undefined);
});

try {
  await app.listen({ port, host: '0.0.0.0' });
  realtime = await attachRealtime(app.server, redisUrl, app.log);
  publishAuctionChanged = realtime.publishAuctionChanged;
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
