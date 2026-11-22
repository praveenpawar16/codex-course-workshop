import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, type RedisClientType } from 'redis';
import { Server } from 'socket.io';

import { CLOSE_NOTIFICATION_CHANNEL } from './closeNotificationBus.js';
import type { CloseNotificationPayload } from './notifyClose.js';

export type AuctionChangedPayload = {
  auctionSlug: string;
  reason: 'bid_accepted';
};

export type RealtimeHub = {
  publishAuctionChanged: (auctionSlug: string) => Promise<void>;
  publishCloseNotification: (payload: CloseNotificationPayload) => Promise<void>;
  close: () => Promise<void>;
};

function roomForSlug(slug: string): string {
  return `auction:${slug}`;
}

function roomForUser(userId: string): string {
  return `user:${userId}`;
}

export async function assertRedisReady(redisUrl: string): Promise<void> {
  const client: RedisClientType = createClient({ url: redisUrl });
  client.on('error', () => {
    // Connection errors surface through connect()/ping(); avoid unhandled 'error' crashes.
  });
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected Redis PING response: ${pong}`);
    }
  } finally {
    await client.quit().catch(() => undefined);
  }
}

export async function attachRealtime(
  httpServer: HttpServer,
  redisUrl: string,
  log?: { error: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void }
): Promise<RealtimeHub> {
  const pubClient: RedisClientType = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();
  const notifySubClient: RedisClientType = createClient({ url: redisUrl });
  pubClient.on('error', (err) => log?.error({ err }, 'redis pub client error'));
  subClient.on('error', (err) => log?.error({ err }, 'redis sub client error'));
  notifySubClient.on('error', (err) => log?.error({ err }, 'redis notify sub client error'));

  await Promise.all([pubClient.connect(), subClient.connect(), notifySubClient.connect()]);

  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: true },
  });
  io.adapter(createAdapter(pubClient, subClient));

  async function emitCloseNotification(payload: CloseNotificationPayload) {
    io.to(roomForUser(payload.recipientUserId)).emit('close-notification', payload);
  }

  await notifySubClient.subscribe(CLOSE_NOTIFICATION_CHANNEL, (message) => {
    try {
      const payload = JSON.parse(message) as CloseNotificationPayload;
      if (!payload?.recipientUserId || !payload?.notificationId) return;
      void emitCloseNotification(payload);
    } catch (error) {
      log?.error({ err: error }, 'invalid close-notification bus payload');
    }
  });

  io.on('connection', (socket) => {
    socket.on('join-auction', (slug: unknown) => {
      if (typeof slug !== 'string' || slug.trim().length === 0) return;
      void socket.join(roomForSlug(slug));
    });
    socket.on('leave-auction', (slug: unknown) => {
      if (typeof slug !== 'string' || slug.trim().length === 0) return;
      void socket.leave(roomForSlug(slug));
    });
    socket.on('join-user', (userId: unknown) => {
      if (typeof userId !== 'string' || userId.trim().length === 0) return;
      void socket.join(roomForUser(userId));
    });
    socket.on('leave-user', (userId: unknown) => {
      if (typeof userId !== 'string' || userId.trim().length === 0) return;
      void socket.leave(roomForUser(userId));
    });
  });

  return {
    async publishAuctionChanged(auctionSlug: string) {
      const payload: AuctionChangedPayload = {
        auctionSlug,
        reason: 'bid_accepted',
      };
      io.to(roomForSlug(auctionSlug)).emit('auction-changed', payload);
    },
    async publishCloseNotification(payload: CloseNotificationPayload) {
      await emitCloseNotification(payload);
    },
    async close() {
      await notifySubClient.unsubscribe(CLOSE_NOTIFICATION_CHANNEL).catch(() => undefined);
      io.disconnectSockets(true);
      // Socket.IO closes an attached HTTP server by default; Fastify owns ours.
      // Detach first so close() only tears down the engine and clients.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (io as any).httpServer = undefined;
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      await Promise.all([
        pubClient.quit().catch(() => undefined),
        subClient.quit().catch(() => undefined),
        notifySubClient.quit().catch(() => undefined),
      ]);
    },
  };
}
