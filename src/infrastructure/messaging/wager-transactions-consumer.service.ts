import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  SubmitWagerTransactionInput,
  SubmitWagerTransactionUseCase,
} from '../../application/use-cases/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager-transaction';

export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';

interface WagerTransactionRequestedMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

export interface ConsumeMessagesResult {
  received: number;
  processed: number;
  failed: number;
}

@Injectable()
export class WagerTransactionsConsumerService {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(
    private readonly orm: MikroORM,
    private readonly submit: SubmitWagerTransactionUseCase,
  ) {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
    this.queueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL
      ?? `${endpoint}/000000000000/wager-transactions.fifo`;
    this.sqs = new SQSClient({
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async consumeOnce(maxMessages = 10, queueUrl = this.queueUrl): Promise<ConsumeMessagesResult> {
    const response = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 1,
    }));
    const messages = response.Messages ?? [];
    let processed = 0;
    let failed = 0;

    for (const message of messages) {
      try {
        await this.processMessage(message, queueUrl);
        processed += 1;
      } catch {
        failed += 1;
      }
    }

    return { received: messages.length, processed, failed };
  }

  async processMessage(message: Message, queueUrl = this.queueUrl): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) throw new Error('SQS message is missing body or receipt handle');
    const envelope = this.parseMessage(message.Body);

    await this.orm.em.transactional(async (em) => {
      const sqlEm = em as unknown as PostgreSqlEntityManager;
      const now = new Date();
      const inserted = await sqlEm.execute(
        `insert into inbox_messages
           (id, consumer_name, message_id, payload, status, attempts, created_at, updated_at)
         values (?, ?, ?, ?::jsonb, 'NEW', 0, ?, ?)
         on conflict (consumer_name, message_id) do nothing
         returning id`,
        [randomUUID(), WAGER_TRANSACTIONS_CONSUMER, envelope.messageId, message.Body, now, now],
      ) as Array<{ id: string }>;
      const inbox = await sqlEm.execute(
        `select id, status
         from inbox_messages
         where consumer_name = ? and message_id = ?
         for update`,
        [WAGER_TRANSACTIONS_CONSUMER, envelope.messageId],
      ) as Array<{ id: string; status: string }>;

      if (inserted.length === 0 && inbox[0]?.status === 'PROCESSED') return;

      await this.submit.executeInTransaction(em, this.toSubmitInput(envelope));
      await sqlEm.execute(
        `update inbox_messages
         set status = 'PROCESSED', attempts = attempts + 1, updated_at = now()
         where id = ?`,
        [inbox[0].id],
      );
    });

    await this.sqs.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }));
  }

  private parseMessage(body: string): WagerTransactionRequestedMessage {
    const parsed = JSON.parse(body) as WagerTransactionRequestedMessage;
    if (!parsed.messageId || parsed.type !== 'WagerTransactionRequested' || !parsed.data) {
      throw new Error('Invalid WagerTransactionRequested message');
    }
    return parsed;
  }

  private toSubmitInput(message: WagerTransactionRequestedMessage): SubmitWagerTransactionInput {
    return {
      walletId: message.data.walletId,
      playerId: message.data.playerId,
      providerId: message.data.providerId,
      externalTransactionId: message.data.externalTransactionId,
      roundId: message.data.roundId,
      gameId: message.data.gameId,
      idempotencyKey: message.data.idempotencyKey,
      kind: message.data.kind,
      amount: message.data.money.amount,
      currency: message.data.money.currency,
      referenceExternalTransactionId: message.data.referenceExternalTransactionId,
    };
  }
}
