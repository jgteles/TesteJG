import { describe, expect, it } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { WagerTransactionsConsumerService } from './wager-transactions-consumer.service';

describe('WagerTransactionsConsumerService shutdown', () => {
  it('starts its consume loop with the application and stops it on shutdown', async () => {
    const consumer = new WagerTransactionsConsumerService({} as never, {} as never);
    let finishPoll!: () => void;
    let polls = 0;
    consumer.consumeOnce = async () => {
      polls += 1;
      await new Promise<void>((resolve) => { finishPoll = resolve; });
      return { received: 0, processed: 0, failed: 0 };
    };

    consumer.onApplicationBootstrap();
    expect(polls).toBe(1);

    const shutdown = consumer.beforeApplicationShutdown();
    finishPoll();
    await shutdown;

    expect(polls).toBe(1);
  });

  it('stops accepting work and waits for processing already in progress', async () => {
    const consumer = new WagerTransactionsConsumerService(
      {} as never,
      {} as never,
    );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const replaceable = consumer as unknown as {
      processMessageInternal(message: Message, queueUrl: string): Promise<void>;
    };
    replaceable.processMessageInternal = async () => pending;

    const processing = consumer.processMessage({}, 'unused');
    let shutdownFinished = false;
    const shutdown = consumer.beforeApplicationShutdown().then(() => { shutdownFinished = true; });
    await Promise.resolve();

    expect(shutdownFinished).toBe(false);
    expect(await consumer.consumeOnce()).toEqual({ received: 0, processed: 0, failed: 0 });

    finish();
    await Promise.all([processing, shutdown]);
    expect(shutdownFinished).toBe(true);
    await expect(consumer.processMessage({}, 'unused')).rejects.toThrow('shutting down');
  });
});
