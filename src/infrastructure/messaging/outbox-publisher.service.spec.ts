import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { OutboxMessageEntity } from '../persistence/mikro-orm/outbox-message.entity';
import { OutboxPublisherService } from './outbox-publisher.service';

describe('OutboxPublisherService', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queueUrl: string;

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
  });

  beforeEach(async () => {
    await orm.em.fork().nativeDelete(OutboxMessageEntity, {});
    await drainQueue();
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
  });

  it('keeps a message pending when SQS publication fails', async () => {
    const messageId = await insertPendingMessage(randomUUID());
    const publisher = new OutboxPublisherService(orm);

    const result = await publisher.publishPending(10, `${queueUrl}-missing`);

    expect(result).toEqual({ selected: 1, published: 0, failed: 1 });
    const stored = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id: messageId });
    expect(stored.status).toBe('PENDING');
    expect(stored.publishedAt).toBeNull();
    expect(stored.attempts).toBe(1);
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
    expect(await receiveMessages()).toHaveLength(1);
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
    expect(await receiveMessages()).toHaveLength(2);
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

  async function receiveMessages() {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));
    return response.Messages ?? [];
  }

  async function drainQueue(): Promise<void> {
    for (;;) {
      const messages = await receiveMessages();
      if (messages.length === 0) return;
      await sqs.send(new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({
          Id: String(index),
          ReceiptHandle: message.ReceiptHandle!,
        })),
      }));
    }
  }
});
