import { createServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';

import { assertRedisReady, attachRealtime } from './realtime.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';

function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('realtime Socket.IO + Redis', () => {
  it('requires redis before attach', async () => {
    await expect(assertRedisReady(redisUrl)).resolves.toBeUndefined();
  });

  it('delivers auction-changed to room members after publish', async () => {
    await assertRedisReady(redisUrl);

    const httpServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP address');
    }

    const realtime = await attachRealtime(httpServer, redisUrl);
    const url = `http://127.0.0.1:${address.port}`;
    const slug = `realtime-lot-${Date.now()}`;

    const watcher: Socket = ioClient(url, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: false,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for connect')), 5000);
        watcher.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        watcher.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      watcher.emit('join-auction', slug);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const pending = waitForEvent<{ auctionSlug: string; reason: string }>(watcher, 'auction-changed');
      await realtime.publishAuctionChanged(slug);
      await expect(pending).resolves.toEqual({
        auctionSlug: slug,
        reason: 'bid_accepted',
      });
    } finally {
      watcher.removeAllListeners();
      watcher.disconnect();
      await realtime.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

afterAll(async () => {
  // Ensure no lingering handles from Redis/Socket.IO in watch mode.
});
