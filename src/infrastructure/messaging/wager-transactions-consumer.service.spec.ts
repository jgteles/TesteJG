import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageBatchCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import { InboxMessageEntity } from '../persistence/mikro-orm/inbox-message.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../persistence/mikro-orm/wallet-ledger-entry.entity';
import { WalletEntity } from '../persistence/mikro-orm/wallet.entity';
import { WagerTransactionEntity, WagerTransactionStatusEntity } from '../persistence/mikro-orm/wager-transaction.entity';
import {
  PERMANENT_INFRASTRUCTURE_FAILURE_CODE,
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionsConsumerService,
} from './wager-transactions-consumer.service';

describe('WagerTransactionsConsumerService', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queueUrl: string;
  let deadLetterQueueUrl: string;
  let createWallet: CreateWalletUseCase;
  let consumer: WagerTransactionsConsumerService;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    createWallet = new CreateWalletUseCase(orm);
    consumer = new WagerTransactionsConsumerService(orm, new SubmitWagerTransactionUseCase(orm));
    sqs = new SQSClient({
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
    queueUrl = queue.QueueUrl!;
    const deadLetterQueue = await sqs.send(new GetQueueUrlCommand({
      QueueName: 'wager-transactions-dlq.fifo',
    }));
    deadLetterQueueUrl = deadLetterQueue.QueueUrl!;
    const deadLetterAttributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueueUrl,
      AttributeNames: ['QueueArn'],
    }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterAttributes.Attributes!.QueueArn,
          maxReceiveCount: '3',
        }),
      },
    }));
  });

  beforeEach(async () => {
    await orm.em.fork().nativeDelete(InboxMessageEntity, {});
    await drainQueue();
    await drainQueue(deadLetterQueueUrl);
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close();
  });

  it('processes a new message, commits its Inbox record, and only then removes it from SQS', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const envelope = wagerMessage(wallet.id, playerId);
    await sendEnvelope(envelope);

    const result = await consumer.consumeOnce(1, queueUrl);

    expect(result).toEqual({ received: 1, processed: 1, failed: 0 });
    const readEm = orm.em.fork();
    const inbox = await readEm.findOneOrFail(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    });
    expect(inbox.status).toBe('PROCESSED');
    expect(inbox.attempts).toBe(1);
    const transaction = await readEm.findOneOrFail(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    });
    const ledger = await readEm.findOneOrFail(WalletLedgerEntryEntity, {
      transaction: { id: transaction.id },
    });
    expect(ledger.entryType).toBe(WalletLedgerEntryType.DEBIT);
    expect(ledger.balanceBefore).toBe('100.00');
    expect(ledger.balanceAfter).toBe('75.00');
    expect(await receiveMessages(1)).toHaveLength(0);
  });

  it('deduplicates a redelivered message using one Inbox record', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const envelope = wagerMessage(wallet.id, playerId);
    const groupId = randomUUID();
    await sendEnvelope(envelope, groupId);
    await sendEnvelope(envelope, groupId);

    expect(await consumer.consumeOnce(1, queueUrl)).toMatchObject({ processed: 1, failed: 0 });
    expect(await consumer.consumeOnce(1, queueUrl)).toMatchObject({ processed: 1, failed: 0 });

    const readEm = orm.em.fork();
    expect(await readEm.count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    })).toBe(1);
    const transaction = await readEm.findOneOrFail(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    });
    expect(await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: transaction.id },
    })).toBe(1);
  });

  it('ACKs a persisted business rejection without duplicating financial effects', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const envelope = wagerMessage(wallet.id, playerId);
    const groupId = randomUUID();
    await sendEnvelope(envelope, groupId);
    await sendEnvelope(envelope, groupId);

    expect(await consumer.consumeOnce(1, queueUrl)).toMatchObject({ processed: 1, failed: 0 });
    expect(await consumer.consumeOnce(1, queueUrl)).toMatchObject({ processed: 1, failed: 0 });

    const readEm = orm.em.fork();
    const transaction = await readEm.findOneOrFail(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    });
    expect(transaction.status).toBe(WagerTransactionStatusEntity.REJECTED);
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await readEm.count(WalletLedgerEntryEntity, { transaction: { id: transaction.id } })).toBe(0);
    expect((await readEm.findOneOrFail(WalletEntity, { id: wallet.id })).balanceAmount).toBe('10.00');
    expect(await receiveMessages(1)).toHaveLength(0);
  });

  it('deduplicates redelivery when the database commits but ACK fails', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const envelope = wagerMessage(wallet.id, playerId);
    await sendEnvelope(envelope);
    const [firstDelivery] = await receiveMessages(1);

    await expect(consumer.processMessage(firstDelivery, `${queueUrl}-missing`)).rejects.toThrow();

    let readEm = orm.em.fork();
    const committedInbox = await readEm.findOneOrFail(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    });
    const committedTransaction = await readEm.findOneOrFail(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    });
    expect(committedInbox.status).toBe('PROCESSED');
    expect(await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: committedTransaction.id },
    })).toBe(1);
    expect((await readEm.findOneOrFail(WalletEntity, { id: wallet.id })).balanceAmount).toBe('75.00');

    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: firstDelivery.ReceiptHandle!,
      VisibilityTimeout: 0,
    }));
    const [redelivered] = await receiveMessages(1);
    expect(JSON.parse(redelivered.Body!).messageId).toBe(envelope.messageId);

    await consumer.processMessage(redelivered, queueUrl);

    readEm = orm.em.fork();
    expect(await readEm.count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    })).toBe(1);
    expect(await readEm.count(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    })).toBe(1);
    expect(await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: committedTransaction.id },
    })).toBe(1);
    expect((await readEm.findOneOrFail(WalletEntity, { id: wallet.id })).balanceAmount).toBe('75.00');
    expect(await receiveMessages(1)).toHaveLength(0);
  });

  it('sends a permanently invalid resource message to DLQ without creating FAILED', async () => {
    const envelope = wagerMessage(randomUUID(), randomUUID());
    await sendEnvelope(envelope);
    expect(await consumer.consumeOnce(1, queueUrl)).toEqual({ received: 1, processed: 1, failed: 0 });

    const readEm = orm.em.fork();
    expect(await readEm.count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    })).toBe(1);
    expect(await readEm.count(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    })).toBe(0);
    expect(await receiveMessages(1)).toHaveLength(0);
    const deadLetters = await receiveMessages(1, deadLetterQueueUrl);
    expect(deadLetters).toHaveLength(1);
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      ReceiptHandle: deadLetters[0].ReceiptHandle!,
    }));
  });

  it('does not ACK a transient infrastructure error and accepts redelivery', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({ playerId });
    const envelope = wagerMessage(wallet.id, playerId);
    const transientSubmit = new SubmitWagerTransactionUseCase(orm);
    transientSubmit.executeInTransaction = async () => {
      throw Object.assign(new Error('PostgreSQL temporarily unavailable'), { code: '57P03' });
    };
    const transientConsumer = new WagerTransactionsConsumerService(orm, transientSubmit);
    await sendEnvelope(envelope);
    const [firstDelivery] = await receiveMessages(1);

    await expect(transientConsumer.processMessage(firstDelivery, queueUrl)).rejects.toThrow(
      'temporarily unavailable',
    );
    expect(await orm.em.fork().count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    })).toBe(0);

    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: firstDelivery.ReceiptHandle!,
      VisibilityTimeout: 0,
    }));
    const redelivered = await receiveMessages(1);
    expect(redelivered).toHaveLength(1);
    expect(JSON.parse(redelivered[0].Body!).messageId).toBe(envelope.messageId);
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: redelivered[0].ReceiptHandle!,
    }));
  });

  it('persists FAILED and sends a valid message to DLQ for permanent infrastructure failure', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({ playerId });
    const envelope = wagerMessage(wallet.id, playerId);
    const permanentSubmit = new SubmitWagerTransactionUseCase(orm);
    permanentSubmit.executeInTransaction = async () => {
      throw Object.assign(new Error('Required database relation is unavailable'), { code: '42P01' });
    };
    const permanentConsumer = new WagerTransactionsConsumerService(orm, permanentSubmit);
    await sendEnvelope(envelope);

    expect(await permanentConsumer.consumeOnce(1, queueUrl))
      .toEqual({ received: 1, processed: 1, failed: 0 });

    const readEm = orm.em.fork();
    const transaction = await readEm.findOneOrFail(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    });
    expect(transaction.status).toBe(WagerTransactionStatusEntity.FAILED);
    expect(transaction.failureCode).toBe(PERMANENT_INFRASTRUCTURE_FAILURE_CODE);
    expect(await readEm.count(WalletLedgerEntryEntity, { transaction: { id: transaction.id } })).toBe(0);
    expect(await readEm.count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
      status: 'PROCESSED',
    })).toBe(1);
    expect(await receiveMessages(1)).toHaveLength(0);
    const deadLetters = await receiveMessages(1, deadLetterQueueUrl);
    expect(deadLetters).toHaveLength(1);
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      ReceiptHandle: deadLetters[0].ReceiptHandle!,
    }));
  });

  it('sends malformed JSON deterministically to DLQ without Inbox or FAILED transaction', async () => {
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: '{invalid-json',
      MessageGroupId: randomUUID(),
      MessageDeduplicationId: randomUUID(),
    }));

    expect(await consumer.consumeOnce(1, queueUrl)).toEqual({ received: 1, processed: 1, failed: 0 });
    expect(await orm.em.fork().count(InboxMessageEntity, {})).toBe(0);
    const deadLetters = await receiveMessages(1, deadLetterQueueUrl);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].Body).toBe('{invalid-json');
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      ReceiptHandle: deadLetters[0].ReceiptHandle!,
    }));
  });

  it('does not duplicate financial processing for concurrent deliveries of the same message', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const envelope = wagerMessage(wallet.id, playerId);
    await sendEnvelope(envelope, randomUUID());
    await sendEnvelope(envelope, randomUUID());
    const messages = await receiveMessages(10);
    expect(messages).toHaveLength(2);

    await Promise.all(messages.map((message) => consumer.processMessage(message, queueUrl)));

    const readEm = orm.em.fork();
    expect(await readEm.count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    })).toBe(1);
    const transaction = await readEm.findOneOrFail(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    });
    expect(await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: transaction.id },
    })).toBe(1);
  });

  it('lets SQS retry a failed message and move it to the native DLQ after maxReceiveCount', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({ playerId });
    const envelope = wagerMessage(wallet.id, playerId);
    const transientSubmit = new SubmitWagerTransactionUseCase(orm);
    transientSubmit.executeInTransaction = async () => {
      throw Object.assign(new Error('Temporary connection failure'), { code: '08006' });
    };
    const transientConsumer = new WagerTransactionsConsumerService(orm, transientSubmit);
    await sendEnvelope(envelope);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [delivery] = await receiveEventually(queueUrl);
      expect(delivery).toBeDefined();
      await expect(transientConsumer.processMessage(delivery, queueUrl)).rejects.toThrow(
        'Temporary connection failure',
      );
      await sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: delivery.ReceiptHandle!,
        VisibilityTimeout: 0,
      }));
    }

    await receiveMessages(1, queueUrl);
    const deadLetters = await receiveEventually(deadLetterQueueUrl);

    expect(deadLetters).toHaveLength(1);
    expect(JSON.parse(deadLetters[0].Body!).messageId).toBe(envelope.messageId);
    const readEm = orm.em.fork();
    expect(await readEm.count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    })).toBe(0);
    expect(await readEm.count(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    })).toBe(0);
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      ReceiptHandle: deadLetters[0].ReceiptHandle!,
    }));
  }, 15_000);

  function wagerMessage(walletId: string, playerId: string) {
    return {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested' as const,
      occurredAt: new Date().toISOString(),
      data: {
        providerId: `provider-consumer-${randomUUID()}`,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'game-consumer',
        kind: WagerTransactionKind.BET,
        money: { amount: '25.00', currency: 'BRL' },
      },
    };
  }

  async function sendEnvelope(
    envelope: ReturnType<typeof wagerMessage>,
    groupId = randomUUID(),
  ): Promise<void> {
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }));
  }

  async function receiveMessages(maxNumberOfMessages: number, targetQueueUrl = queueUrl) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: targetQueueUrl,
      MaxNumberOfMessages: maxNumberOfMessages,
      WaitTimeSeconds: 1,
    }));
    return response.Messages ?? [];
  }

  async function receiveEventually(targetQueueUrl: string) {
    for (let poll = 0; poll < 5; poll += 1) {
      const messages = await receiveMessages(1, targetQueueUrl);
      if (messages.length > 0) return messages;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [];
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
});
