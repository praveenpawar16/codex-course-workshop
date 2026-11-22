import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';

import {
  AUCTION_CLOSE_EXCHANGE,
  AUCTION_CLOSE_QUEUE,
  AUCTION_CLOSE_ROUTING_KEY,
} from './rabbitmq.js';

export type AuctionClosedMessageHandler = (payload: unknown, raw: ConsumeMessage) => Promise<void>;

export type RabbitConsumer = {
  close: () => Promise<void>;
};

export async function connectAuctionCloseConsumer(
  url: string,
  onMessage: AuctionClosedMessageHandler,
  options: { logger?: { error: (obj: unknown, msg?: string) => void } } = {}
): Promise<RabbitConsumer> {
  const connection: ChannelModel = await amqp.connect(url);
  const channel: Channel = await connection.createChannel();
  await channel.prefetch(1);

  await channel.assertExchange(AUCTION_CLOSE_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(AUCTION_CLOSE_QUEUE, { durable: true });
  await channel.bindQueue(AUCTION_CLOSE_QUEUE, AUCTION_CLOSE_EXCHANGE, AUCTION_CLOSE_ROUTING_KEY);

  connection.on('error', (error) => {
    options.logger?.error({ err: error }, 'rabbitmq consumer connection error');
  });

  await channel.consume(AUCTION_CLOSE_QUEUE, (message) => {
    if (!message) return;
    void (async () => {
      try {
        const payload = JSON.parse(message.content.toString('utf8')) as unknown;
        await onMessage(payload, message);
        channel.ack(message);
      } catch (error) {
        options.logger?.error({ err: error }, 'auction.close consumer failed');
        const requeue = !(error instanceof SyntaxError) && !(error instanceof Error && /Invalid auction\.closed/.test(error.message));
        // Requeue transient failures only; deferred DLQ / elaborate retry.
        channel.nack(message, false, requeue);
      }
    })();
  });

  return {
    async close() {
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}
