import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  BeforeApplicationShutdown,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { LockMode, MikroORM } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  SubmitWagerTransactionInput,
  SubmitWagerTransactionUseCase,
} from '../../application/use-cases/submit-wager-transaction.use-case';
import { DomainError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { OperationalMetricsService } from '../../observability/operational-metrics.service';
import { WalletEntity } from '../persistence/mikro-orm/wallet.entity';
import {
  WagerTransactionEntity,
  WagerTransactionKindEntity,
  WagerTransactionStatusEntity,
} from '../persistence/mikro-orm/wager-transaction.entity';

export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';
export const PERMANENT_INFRASTRUCTURE_FAILURE_CODE = 'PERMANENT_INFRASTRUCTURE_ERROR';

class InvalidWagerMessageError extends Error {}

type FailureCategory = 'PERMANENT_MESSAGE' | 'PERMANENT_INFRASTRUCTURE' | 'TRANSIENT_INFRASTRUCTURE';

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
export class WagerTransactionsConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionsConsumerService.name);
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;
  private readonly deadLetterQueueUrl: string;
  private acceptingMessages = true;
  private readonly inFlight = new Set<Promise<void>>();
  private consumeLoop?: Promise<void>;

  constructor(
    private readonly orm: MikroORM,
    private readonly submit: SubmitWagerTransactionUseCase,
    @Optional() private readonly metrics?: OperationalMetricsService,
  ) {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
    this.queueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL
      ?? `${endpoint}/000000000000/wager-transactions.fifo`;
    this.deadLetterQueueUrl = process.env.WAGER_TRANSACTIONS_DLQ_URL
      ?? `${endpoint}/000000000000/wager-transactions-dlq.fifo`;
    this.sqs = new SQSClient({
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  onApplicationBootstrap(): void {
    this.consumeLoop = this.runConsumeLoop();
  }

  async consumeOnce(maxMessages = 10, queueUrl = this.queueUrl): Promise<ConsumeMessagesResult> {
    if (!this.acceptingMessages) return { received: 0, processed: 0, failed: 0 };
    const response = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
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
    if (!this.acceptingMessages) throw new Error('Consumer is shutting down');
    const processing = this.processMessageInternal(message, queueUrl);
    this.inFlight.add(processing);
    try {
      await processing;
    } finally {
      this.inFlight.delete(processing);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.acceptingMessages = false;
    await this.consumeLoop;
    await Promise.allSettled(this.inFlight);
    this.sqs.destroy();
  }

  private async runConsumeLoop(): Promise<void> {
    while (this.acceptingMessages) {
      try {
        await this.consumeOnce();
      } catch (error) {
        if (this.acceptingMessages) {
          this.logger.error({ event: 'wager_consumer_poll_failed', error: String(error) });
        }
      }
    }
  }

  private async processMessageInternal(message: Message, queueUrl: string): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) throw new Error('SQS message is missing body or receipt handle');
    let envelope: WagerTransactionRequestedMessage;
    try {
      envelope = this.parseMessage(message.Body);
    } catch (error) {
      await this.moveToDeadLetterQueue(message, queueUrl, undefined, error);
      return;
    }
    let duplicate = false;
    let result: Awaited<ReturnType<SubmitWagerTransactionUseCase['executeInTransaction']>> | undefined;
    try {
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

      if (inserted.length === 0 && inbox[0]?.status === 'PROCESSED') {
        duplicate = true;
        return;
      }

      result = await this.submit.executeInTransaction(em, this.toSubmitInput(envelope));
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
      if (duplicate) this.metrics?.transaction('DUPLICATE', true, 0);
      if (result) this.metrics?.transaction(result.status, result.idempotentReplay, 0);
      this.logger.log({
        event: duplicate ? 'wager_message_duplicate' : 'wager_message_processed',
        correlationId: envelope.data.idempotencyKey,
        messageId: envelope.messageId,
        transactionId: result?.id,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      });
    } catch (error) {
      const category = this.classifyFailure(error);
      if (category === 'PERMANENT_MESSAGE') {
        await this.persistTerminalInbox(envelope, message.Body);
        await this.moveToDeadLetterQueue(message, queueUrl, envelope, error);
        return;
      }
      if (category === 'PERMANENT_INFRASTRUCTURE') {
        await this.persistFailedTransaction(envelope, message.Body);
        await this.moveToDeadLetterQueue(message, queueUrl, envelope, error);
        return;
      }

      this.metrics?.retry();
      if (Number(message.Attributes?.ApproximateReceiveCount ?? '0') >= 3) this.metrics?.dlq();
      this.logger.error({
        event: 'wager_message_failed',
        correlationId: envelope.data.idempotencyKey,
        messageId: envelope.messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      });
      throw error;
    }
  }

  private parseMessage(body: string): WagerTransactionRequestedMessage {
    let parsed: WagerTransactionRequestedMessage;
    try {
      parsed = JSON.parse(body) as WagerTransactionRequestedMessage;
    } catch {
      throw new InvalidWagerMessageError('Invalid WagerTransactionRequested JSON');
    }
    const data = parsed.data;
    const requiredStrings = data && [
      parsed.messageId,
      parsed.occurredAt,
      data.providerId,
      data.externalTransactionId,
      data.idempotencyKey,
      data.playerId,
      data.walletId,
      data.roundId,
      data.gameId,
      data.money?.amount,
      data.money?.currency,
    ];
    if (
      parsed.type !== 'WagerTransactionRequested'
      || !requiredStrings
      || requiredStrings.some((value) => typeof value !== 'string' || value.trim().length === 0)
      || !Object.values(WagerTransactionKind).includes(data.kind)
    ) {
      throw new InvalidWagerMessageError('Invalid WagerTransactionRequested message');
    }
    return parsed;
  }

  private classifyFailure(error: unknown): FailureCategory {
    if (
      error instanceof InvalidWagerMessageError
      || error instanceof BadRequestException
      || error instanceof ConflictException
      || error instanceof NotFoundException
      || error instanceof DomainError
      || (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500)
    ) {
      return 'PERMANENT_MESSAGE';
    }

    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code.startsWith('42') || code === '0A000') {
      return 'PERMANENT_INFRASTRUCTURE';
    }
    return 'TRANSIENT_INFRASTRUCTURE';
  }

  private async persistTerminalInbox(envelope: WagerTransactionRequestedMessage, body: string): Promise<void> {
    await this.orm.em.getConnection().execute(
      `insert into inbox_messages
         (id, consumer_name, message_id, payload, status, attempts, created_at, updated_at)
       values (?, ?, ?, ?::jsonb, 'PROCESSED', 1, now(), now())
       on conflict (consumer_name, message_id)
       do update set status = 'PROCESSED', attempts = inbox_messages.attempts + 1, updated_at = now()`,
      [randomUUID(), WAGER_TRANSACTIONS_CONSUMER, envelope.messageId, body],
    );
  }

  private async persistFailedTransaction(envelope: WagerTransactionRequestedMessage, body: string): Promise<void> {
    const input = this.toSubmitInput(envelope);
    await this.orm.em.transactional(async (em) => {
      const sqlEm = em as unknown as PostgreSqlEntityManager;
      await sqlEm.execute(
        `insert into inbox_messages
           (id, consumer_name, message_id, payload, status, attempts, created_at, updated_at)
         values (?, ?, ?, ?::jsonb, 'PROCESSED', 1, now(), now())
         on conflict (consumer_name, message_id)
         do update set status = 'PROCESSED', attempts = inbox_messages.attempts + 1, updated_at = now()`,
        [randomUUID(), WAGER_TRANSACTIONS_CONSUMER, envelope.messageId, body],
      );
      await sqlEm.execute(
        'insert into idempotency_keys (key) values (?) on conflict do nothing',
        [envelope.data.idempotencyKey],
      );
      await sqlEm.execute(
        'select key from idempotency_keys where key = ? for update',
        [envelope.data.idempotencyKey],
      );

      const existing = await em.findOne(WagerTransactionEntity, {
        idempotencyKey: envelope.data.idempotencyKey,
      });
      if (existing) return;

      const wallet = await em.findOneOrFail(WalletEntity, { id: envelope.data.walletId }, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      const amount = Money.from(envelope.data.money);
      const transaction = WagerTransaction.create({
        id: randomUUID(),
        walletId: wallet.id,
        playerId: envelope.data.playerId,
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        idempotencyKey: envelope.data.idempotencyKey,
        payloadHash: this.submit.payloadHashFor(input),
        kind: envelope.data.kind,
        amount,
        currency: amount.currency,
        referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
      });
      transaction.markFailed(PERMANENT_INFRASTRUCTURE_FAILURE_CODE);
      em.persist(em.create(WagerTransactionEntity, {
        id: transaction.id,
        wallet,
        playerId: transaction.playerId,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        idempotencyKey: transaction.idempotencyKey,
        kind: transaction.kind as unknown as WagerTransactionKindEntity,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        status: WagerTransactionStatusEntity.FAILED,
        payloadHash: transaction.payloadHash,
        failureCode: transaction.failureCode,
        referenceAttempts: 0,
        balanceAfter: wallet.balanceAmount,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
      }));
    });
  }

  private async moveToDeadLetterQueue(
    message: Message,
    sourceQueueUrl: string,
    envelope?: WagerTransactionRequestedMessage,
    error?: unknown,
  ): Promise<void> {
    await this.sqs.send(new SendMessageCommand({
      QueueUrl: this.deadLetterQueueUrl,
      MessageBody: message.Body!,
      MessageGroupId: envelope?.data.walletId ?? envelope?.messageId ?? message.MessageId ?? randomUUID(),
      MessageDeduplicationId: envelope?.messageId ?? message.MessageId ?? randomUUID(),
    }));
    await this.sqs.send(new DeleteMessageCommand({
      QueueUrl: sourceQueueUrl,
      ReceiptHandle: message.ReceiptHandle!,
    }));
    this.metrics?.dlq();
    this.logger.error({
      event: 'wager_message_sent_to_dlq',
      category: envelope ? this.classifyFailure(error) : 'PERMANENT_MESSAGE',
      correlationId: envelope?.data.idempotencyKey,
      messageId: envelope?.messageId ?? message.MessageId,
      walletId: envelope?.data.walletId,
      providerId: envelope?.data.providerId,
    });
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
