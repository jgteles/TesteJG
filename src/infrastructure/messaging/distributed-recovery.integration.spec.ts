import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { MikroORM } from '@mikro-orm/core';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import type {
  SubmitWagerTransactionInput,
  SubmitWagerTransactionOutput,
} from '../../application/use-cases/submit-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import { InboxMessageEntity } from '../persistence/mikro-orm/inbox-message.entity';
import { OutboxMessageEntity } from '../persistence/mikro-orm/outbox-message.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../persistence/mikro-orm/wallet-ledger-entry.entity';
import { WalletEntity } from '../persistence/mikro-orm/wallet.entity';
import { WagerTransactionEntity } from '../persistence/mikro-orm/wager-transaction.entity';
import { WAGER_TRANSACTIONS_CONSUMER } from './wager-transactions-consumer.service';

const workerPath = resolve(process.cwd(), 'test/distributed-recovery.worker.ts');

interface ManagedChild {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  errors: () => string;
  exited: Promise<number | null>;
}

describe('distributed recovery with independent processes', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  const queueUrls = new Set<string>();
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    sqs = new SQSClient({
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    await Promise.allSettled([...queueUrls].map((queueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }))));
    sqs.destroy();
    await orm.close();
  });

  it('serializes two 80.00 bets across three simultaneous processes', async () => {
    const playerId = randomUUID();
    const wallet = await new CreateWalletUseCase(orm).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const providerId = `provider-distributed-${randomUUID()}`;
    const common = {
      walletId: wallet.id,
      playerId,
      providerId,
      roundId: randomUUID(),
      gameId: 'distributed-wallet-lock',
      kind: WagerTransactionKind.BET,
      amount: '80.00',
      currency: 'BRL',
    };
    const first: SubmitWagerTransactionInput = {
      ...common,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const second: SubmitWagerTransactionInput = {
      ...common,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const barrierDirectory = await mkdtemp(join(tmpdir(), 'wager-three-processes-'));
    const barrierPath = join(barrierDirectory, 'go');
    const processes = [
      startWorker('submit', first, barrierPath),
      startWorker('submit', second, barrierPath),
      startWorker('submit', first, barrierPath),
    ];

    try {
      await Promise.all(processes.map((process) => waitForOutput(process, 'READY', 10_000)));
      await writeFile(barrierPath, 'go');
      const results = await Promise.all(processes.map((process) => workerResult<SubmitWagerTransactionOutput>(process)));
      expect(results.filter((result) => result.idempotentReplay)).toHaveLength(1);
    } finally {
      await rm(barrierDirectory, { recursive: true, force: true });
    }

    const readEm = orm.em.fork();
    const transactions = await readEm.find(WagerTransactionEntity, { providerId });
    expect(transactions).toHaveLength(2);
    expect(transactions.filter((transaction) => transaction.status === WagerTransactionStatus.PROCESSED)).toHaveLength(1);
    expect(transactions.filter((transaction) => transaction.status === WagerTransactionStatus.REJECTED)).toHaveLength(1);
    expect((await readEm.findOneOrFail(WalletEntity, { id: wallet.id })).balanceAmount).toBe('20.00');
    expect(await readEm.count(WalletLedgerEntryEntity, {
      wallet: { id: wallet.id },
      entryType: WalletLedgerEntryType.DEBIT,
    })).toBe(1);
    await expectLedgerBalance(wallet.id, '20.00');
  }, 30_000);

  it('keeps wallet, transaction, ledger and idempotency after a real process restart', async () => {
    const playerId = randomUUID();
    const wallet = await new CreateWalletUseCase(orm).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input: SubmitWagerTransactionInput = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-restart-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'restart-consistency',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
      currency: 'BRL',
    };

    const first = await workerResult<SubmitWagerTransactionOutput>(startWorker('submit', input));
    const restarted = await workerResult<SubmitWagerTransactionOutput>(startWorker('submit', input));

    expect(first.idempotentReplay).toBe(false);
    expect(restarted.idempotentReplay).toBe(true);
    expect(restarted.id).toBe(first.id);
    expect(restarted.balance.amount).toBe('75.00');
    const readEm = orm.em.fork();
    expect(await readEm.count(WagerTransactionEntity, { idempotencyKey: input.idempotencyKey })).toBe(1);
    expect(await readEm.count(WalletLedgerEntryEntity, {
      wallet: { id: wallet.id },
      entryType: WalletLedgerEntryType.DEBIT,
    })).toBe(1);
    expect((await readEm.findOneOrFail(WalletEntity, { id: wallet.id })).balanceAmount).toBe('75.00');
    await expectLedgerBalance(wallet.id, '75.00');
  }, 30_000);

  it('recovers in a new process when the consumer dies after commit and before ACK', async () => {
    const queueUrl = await createQueue('crash-before-ack', { VisibilityTimeout: '1' });
    const playerId = randomUUID();
    const wallet = await new CreateWalletUseCase(orm).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const envelope = wagerEnvelope(wallet.id, playerId, '80.00');
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: envelope.messageId,
    }));

    const crashingWorker = startWorker('crash-consumer-before-ack', { queueUrl });
    await waitForOutput(crashingWorker, 'COMMITTED_BEFORE_ACK', 15_000);
    crashingWorker.child.kill('SIGKILL');
    await crashingWorker.exited;

    const redelivery = await workerResult<{ received: number; processed: number; failed: number }>(
      startWorker('consume-redelivery', { queueUrl }),
    );
    expect(redelivery).toEqual({ received: 1, processed: 1, failed: 0 });

    const readEm = orm.em.fork();
    expect(await readEm.count(InboxMessageEntity, {
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId: envelope.messageId,
    })).toBe(1);
    expect(await readEm.count(WagerTransactionEntity, {
      idempotencyKey: envelope.data.idempotencyKey,
    })).toBe(1);
    expect(await readEm.count(WalletLedgerEntryEntity, {
      wallet: { id: wallet.id },
      entryType: WalletLedgerEntryType.DEBIT,
    })).toBe(1);
    expect((await readEm.findOneOrFail(WalletEntity, { id: wallet.id })).balanceAmount).toBe('20.00');
    await expectLedgerBalance(wallet.id, '20.00');
  }, 30_000);

  it('recovers a PENDING outbox after SQS accepts the event and the publisher dies', async () => {
    const queueUrl = await createQueue('outbox-crash');
    const playerId = randomUUID();
    const wallet = await new CreateWalletUseCase(orm).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const transaction = await new SubmitWagerTransactionUseCase(orm).execute({
      walletId: wallet.id,
      playerId,
      providerId: `provider-outbox-crash-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'outbox-crash-recovery',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '20.00',
      currency: 'BRL',
    });
    const target = await insertOldestPendingOutbox(transaction.id, wallet.id);

    const crashingPublisher = startWorker('crash-publisher-after-send', { queueUrl });
    await waitForOutput(crashingPublisher, 'SQS_ACCEPTED_BEFORE_DATABASE_UPDATE', 15_000);
    crashingPublisher.child.kill('SIGKILL');
    await crashingPublisher.exited;
    await waitUntil(async () => {
      const stored = await orm.em.fork().findOne(OutboxMessageEntity, { id: target });
      return stored?.status === 'PENDING';
    }, 5_000, 'Outbox row did not become recoverable after publisher death');

    const recovered = await workerResult<{ selected: number; published: number; failed: number }>(
      startWorker('publish-pending', { queueUrl }),
    );
    expect(recovered).toEqual({ selected: 1, published: 1, failed: 0 });
    const stored = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id: target });
    expect(stored.status).toBe('PUBLISHED');
    expect(stored.attempts).toBe(1);

    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));
    expect(response.Messages).toHaveLength(1);
    expect(JSON.parse(response.Messages![0].Body!).eventId).toBe(target);
    expect(await orm.em.fork().count(WagerTransactionEntity, { id: transaction.id })).toBe(1);
    expect(await orm.em.fork().count(WalletLedgerEntryEntity, {
      wallet: { id: wallet.id },
      entryType: WalletLedgerEntryType.DEBIT,
    })).toBe(1);
    expect((await orm.em.fork().findOneOrFail(WalletEntity, { id: wallet.id })).balanceAmount).toBe('80.00');
    await expectLedgerBalance(wallet.id, '80.00');
  }, 30_000);

  function startWorker(workerCommand: string, value: unknown, barrierPath?: string): ManagedChild {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
    const child = spawn(process.execPath, ['run', workerPath, workerCommand, encoded, ...(barrierPath ? [barrierPath] : [])], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolveExit) => {
      child.once('exit', (code) => {
        children.delete(child);
        resolveExit(code);
      });
    });
    return { child, output: () => stdout, errors: () => stderr, exited };
  }

  async function waitForOutput(process: ManagedChild, marker: string, timeoutMs: number): Promise<void> {
    await waitUntil(
      async () => process.output().includes(marker),
      timeoutMs,
      `Worker did not emit ${marker}. stdout=${process.output()} stderr=${process.errors()}`,
      process,
    );
  }

  async function workerResult<T>(process: ManagedChild): Promise<T> {
    const code = await process.exited;
    if (code !== 0) throw new Error(`Worker exited with ${code}. stdout=${process.output()} stderr=${process.errors()}`);
    const resultLine = process.output().split(/\r?\n/).find((line) => line.startsWith('RESULT:'));
    if (!resultLine) throw new Error(`Worker returned no result. stdout=${process.output()} stderr=${process.errors()}`);
    return JSON.parse(resultLine.slice('RESULT:'.length)) as T;
  }

  async function createQueue(prefix: string, attributes: Record<string, string> = {}): Promise<string> {
    const queue = await sqs.send(new CreateQueueCommand({
      QueueName: `${prefix}-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ...attributes,
      },
    }));
    queueUrls.add(queue.QueueUrl!);
    return queue.QueueUrl!;
  }

  async function expectLedgerBalance(walletId: string, expected: string): Promise<void> {
    const rows = await orm.em.getConnection().execute(
      `select balance_after
       from wallet_ledger_entries
       where wallet_id = ?
       order by created_at desc, id desc
       limit 1`,
      [walletId],
    ) as Array<{ balance_after: string }>;
    expect(rows[0]?.balance_after).toBe(expected);
  }

  async function insertOldestPendingOutbox(transactionId: string, walletId: string): Promise<string> {
    const id = randomUUID();
    const occurredAt = new Date('2000-01-01T00:00:00.000Z');
    const em = orm.em.fork();
    em.persist(em.create(OutboxMessageEntity, {
      id,
      eventType: 'WagerTransactionProcessed',
      aggregateType: 'WagerTransaction',
      aggregateId: transactionId,
      payload: {
        eventId: id,
        eventType: 'WagerTransactionProcessed',
        aggregateId: transactionId,
        correlationId: randomUUID(),
        occurredAt: occurredAt.toISOString(),
        version: 1,
        data: { walletId },
      },
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }));
    await em.flush();
    return id;
  }
});

function wagerEnvelope(walletId: string, playerId: string, amount: string) {
  const messageId = randomUUID();
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: `provider-crash-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'crash-before-ack',
      kind: WagerTransactionKind.BET,
      money: { amount, currency: 'BRL' },
    },
  };
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
  process?: ManagedChild,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (process && process.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
