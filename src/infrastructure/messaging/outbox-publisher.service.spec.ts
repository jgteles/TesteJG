import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { OutboxMessageEntity } from '../persistence/mikro-orm/outbox-message.entity';
import { OUTBOX_RETRY_BACKOFF_BASE_MS, OutboxPublisherService } from './outbox-publisher.service';

describe('OutboxPublisherService', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queueUrl: string;
  let eventsQueueUrl: string;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    sqs = new SQSClient({
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
    queueUrl = queue.QueueUrl!;
    const eventsQueue = await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-events.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    eventsQueueUrl = eventsQueue.QueueUrl!;
  });

  beforeEach(async () => {
    await orm.em.fork().nativeDelete(OutboxMessageEntity, {});
    await drainQueue();
    await drainQueue(eventsQueueUrl);
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close();
  });

  it('publishes a pending message and marks it as published afterwards', async () => {
    const messageId = await insertPendingMessage(randomUUID());
    const publisher = new OutboxPublisherService(orm);

    const result = await publisher.publishPending(10, queueUrl);

    expect(result).toEqual({ selected: 1, published: 1, failed: 0 });
    const stored = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id: messageId });
    expect(stored.status).toBe('PUBLISHED');
    expect(stored.publishedAt).toBeInstanceOf(Date);
    expect(stored.attempts).toBe(1);
    const messages = await receiveMessages();
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].Body!).eventId).toBe(messageId);
    await deleteMessages(messages);
  });

  it('publishes outbox events to the events queue instead of the transaction input queue', async () => {
    const messageId = await insertPendingMessage(randomUUID());
    const publisher = new OutboxPublisherService(orm);

    expect(await publisher.publishPending()).toEqual({ selected: 1, published: 1, failed: 0 });

    expect(await receiveMessages(1, queueUrl)).toHaveLength(0);
    const events = await receiveMessages(1, eventsQueueUrl);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].Body!).eventId).toBe(messageId);
    await deleteMessages(events, eventsQueueUrl);
  });

  it('persists exponential backoff and only retries a failed message when it is due', async () => {
    const messageId = await insertPendingMessage(randomUUID());
    const publisher = new OutboxPublisherService(orm);
    const firstAttemptStartedAt = Date.now();

    const result = await publisher.publishPending(10, `${queueUrl}-missing`);

    expect(result).toEqual({ selected: 1, published: 0, failed: 1 });
    const stored = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id: messageId });
    expect(stored.status).toBe('PENDING');
    expect(stored.publishedAt).toBeNull();
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      firstAttemptStartedAt + OUTBOX_RETRY_BACKOFF_BASE_MS,
    );

    const restartedPublisher = new OutboxPublisherService(orm);
    expect(await restartedPublisher.publishPending(10, queueUrl))
      .toEqual({ selected: 0, published: 0, failed: 0 });

    await makeDue(messageId);
    const secondAttemptStartedAt = Date.now();
    expect(await restartedPublisher.publishPending(10, `${queueUrl}-missing`))
      .toEqual({ selected: 1, published: 0, failed: 1 });

    const failedTwice = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id: messageId });
    expect(failedTwice.status).toBe('PENDING');
    expect(failedTwice.attempts).toBe(2);
    expect(failedTwice.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      secondAttemptStartedAt + (OUTBOX_RETRY_BACKOFF_BASE_MS * 2),
    );

    expect(await restartedPublisher.publishPending(10, queueUrl))
      .toEqual({ selected: 0, published: 0, failed: 0 });

    await makeDue(messageId);
    const retryResult = await restartedPublisher.publishPending(10, queueUrl);

    expect(retryResult).toEqual({ selected: 1, published: 1, failed: 0 });
    const recovered = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id: messageId });
    expect(recovered.status).toBe('PUBLISHED');
    expect(recovered.publishedAt).toBeInstanceOf(Date);
    expect(recovered.attempts).toBe(3);
    const messages = await receiveMessages();
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].Body!).eventId).toBe(messageId);
    await deleteMessages(messages);
  });

  it('does not let two publisher instances publish the same pending message', async () => {
    const messageId = await insertPendingMessage(randomUUID());
    const first = new OutboxPublisherService(orm);
    const second = new OutboxPublisherService(orm);

    const results = await Promise.all([
      first.publishPending(1, queueUrl),
      second.publishPending(1, queueUrl),
    ]);

    expect(results.reduce((total, result) => total + result.published, 0)).toBe(1);
    const stored = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id: messageId });
    expect(stored.status).toBe('PUBLISHED');
    expect(stored.attempts).toBe(1);
    const messages = await receiveMessages();
    expect(messages).toHaveLength(1);
    await deleteMessages(messages);
  });

  it('allows different pending messages to be processed by concurrent publishers', async () => {
    const firstId = await insertPendingMessage(randomUUID());
    const secondId = await insertPendingMessage(randomUUID());
    const first = new OutboxPublisherService(orm);
    const second = new OutboxPublisherService(orm);

    const results = await Promise.all([
      first.publishPending(1, queueUrl),
      second.publishPending(1, queueUrl),
    ]);

    expect(results.reduce((total, result) => total + result.published, 0)).toBe(2);
    const stored = await orm.em.fork().find(OutboxMessageEntity, {
      id: { $in: [firstId, secondId] },
    });
    expect(stored).toHaveLength(2);
    expect(stored.every((message) => message.status === 'PUBLISHED')).toBe(true);
    const messages = await receiveMessages();
    expect(messages).toHaveLength(2);
    await deleteMessages(messages);
  });

  async function insertPendingMessage(walletId: string): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    const em = orm.em.fork();
    em.persist(em.create(OutboxMessageEntity, {
      id,
      eventType: 'WagerTransactionProcessed',
      aggregateType: 'WagerTransaction',
      aggregateId: randomUUID(),
      payload: {
        eventId: id,
        eventType: 'WagerTransactionProcessed',
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: now.toISOString(),
        version: 1,
        data: { walletId },
      },
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    await em.flush();
    return id;
  }

  async function makeDue(messageId: string): Promise<void> {
    await orm.em.getConnection().execute(
      `update outbox_messages
       set next_attempt_at = now() - interval '1 millisecond'
       where id = ?`,
      [messageId],
    );
  }

  async function receiveMessages(maxNumberOfMessages = 10, targetQueueUrl = queueUrl) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: targetQueueUrl,
      MaxNumberOfMessages: maxNumberOfMessages,
      WaitTimeSeconds: 1,
    }));
    return response.Messages ?? [];
  }

  async function drainQueue(targetQueueUrl = queueUrl): Promise<void> {
    for (;;) {
      const messages = await receiveMessages(10, targetQueueUrl);
      if (messages.length === 0) return;
      await sqs.send(new DeleteMessageBatchCommand({
        QueueUrl: targetQueueUrl,
        Entries: messages.map((message, index) => ({
          Id: String(index),
          ReceiptHandle: message.ReceiptHandle!,
        })),
      }));
    }
  }

  async function deleteMessages(
    messages: Awaited<ReturnType<typeof receiveMessages>>,
    targetQueueUrl = queueUrl,
  ): Promise<void> {
    await sqs.send(new DeleteMessageBatchCommand({
      QueueUrl: targetQueueUrl,
      Entries: messages.map((message, index) => ({
        Id: String(index),
        ReceiptHandle: message.ReceiptHandle!,
      })),
    }));
  }
});
