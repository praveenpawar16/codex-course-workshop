import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';

import { isTraceparent } from './traceContext.js';

export const AUCTION_CLOSE_EXCHANGE = 'auction.close';
export const AUCTION_CLOSE_ROUTING_KEY = 'auction.closed';
export const AUCTION_CLOSE_QUEUE = 'auction.close';

export type RabbitPublisher = {
  publishAuctionClosed: (
    payload: unknown,
    headers?: Record<string, string>
  ) => Promise<void>;
  close: () => Promise<void>;
};

export async function connectRabbitPublisher(
  url: string,
  options: { logger?: { error: (obj: unknown, msg?: string) => void } } = {}
): Promise<RabbitPublisher> {
  const connection: ChannelModel = await amqp.connect(url);
  const channel: ConfirmChannel = await connection.createConfirmChannel();

  await channel.assertExchange(AUCTION_CLOSE_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(AUCTION_CLOSE_QUEUE, { durable: true });
  await channel.bindQueue(AUCTION_CLOSE_QUEUE, AUCTION_CLOSE_EXCHANGE, AUCTION_CLOSE_ROUTING_KEY);

  connection.on('error', (error) => {
    options.logger?.error({ err: error }, 'rabbitmq connection error');
  });

  return {
    async publishAuctionClosed(payload: unknown, headers?: Record<string, string>) {
      const body = Buffer.from(JSON.stringify(payload));
      const messageHeaders: Record<string, string> = { ...headers };
      const payloadTraceparent =
        payload && typeof payload === 'object'
          ? (payload as { traceparent?: unknown }).traceparent
          : undefined;
      // Explicit headers (e.g. the publish span) win; otherwise fall back to the outbox payload.
      if (!messageHeaders.traceparent && isTraceparent(payloadTraceparent)) {
        messageHeaders.traceparent = payloadTraceparent.trim();
      }
      const wrote = channel.publish(AUCTION_CLOSE_EXCHANGE, AUCTION_CLOSE_ROUTING_KEY, body, {
        contentType: 'application/json',
        persistent: true,
        headers: messageHeaders,
      });
      if (!wrote) {
        await new Promise<void>((resolve) => channel.once('drain', () => resolve()));
      }
      await channel.waitForConfirms();
    },
    async close() {
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}
