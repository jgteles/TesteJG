import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { ReprocessPendingReferenceUseCase } from '../../application/use-cases/reprocess-pending-reference.use-case';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import { OutboxMessageEntity } from '../persistence/mikro-orm/outbox-message.entity';
import { WalletLedgerEntryEntity } from '../persistence/mikro-orm/wallet-ledger-entry.entity';
import {
  WagerTransactionEntity,
  WagerTransactionStatusEntity,
} from '../persistence/mikro-orm/wager-transaction.entity';
import {
  MAX_PENDING_REFERENCE_ATTEMPTS,
  PENDING_REFERENCE_BACKOFF_BASE_MS,
  PendingReferenceWorkerService,
} from './pending-reference-worker.service';

describe('PendingReferenceWorkerService', () => {
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let submit: SubmitWagerTransactionUseCase;
  let reprocess: ReprocessPendingReferenceUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    createWallet = new CreateWalletUseCase(orm);
    submit = new SubmitWagerTransactionUseCase(orm);
    reprocess = new ReprocessPendingReferenceUseCase(orm);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await orm.em.getConnection().execute(
      `UPDATE wager_transactions
       SET next_reference_attempt_at = NOW() + interval '1 day'
       WHERE status = 'PENDING_REFERENCE'`,
    );
  });

  it('persists an exponential retry when the reference is still absent', async () => {
    const pending = await createPendingRefund();
    expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    const now = new Date();
    const worker = new PendingReferenceWorkerService(orm, reprocess);

    expect(await worker.processDueOnce(now)).toBe(1);

    const stored = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { id: pending.id });
    expect(stored.status).toBe(WagerTransactionStatusEntity.PENDING_REFERENCE);
    expect(stored.referenceAttempts).toBe(1);
    expect(stored.nextReferenceAttemptAt!.getTime() - now.getTime())
      .toBe(PENDING_REFERENCE_BACKOFF_BASE_MS);
  });

  it('processes the refund when its BET arrives before the next due attempt', async () => {
    const pending = await createPendingRefund();
    const firstWorker = new PendingReferenceWorkerService(orm, reprocess);
    await firstWorker.processDueOnce(new Date());
    let stored = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { id: pending.id });

    await submit.execute({ ...pending.input, kind: WagerTransactionKind.BET });
    const recreatedWorker = new PendingReferenceWorkerService(
      orm,
      new ReprocessPendingReferenceUseCase(orm),
    );
    expect(await recreatedWorker.processDueOnce(stored.nextReferenceAttemptAt!)).toBe(1);

    stored = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { id: pending.id });
    expect(stored.status).toBe(WagerTransactionStatusEntity.PROCESSED);
    expect(stored.referenceAttempts).toBe(2);
    expect(stored.nextReferenceAttemptAt).toBeNull();
    expect(await orm.em.fork().count(WalletLedgerEntryEntity, {
      transaction: { id: pending.id },
    })).toBe(1);
  });

  it('lets two worker instances claim and apply the same pending reversal only once', async () => {
    const pending = await createPendingRefund();
    await submit.execute({ ...pending.input, kind: WagerTransactionKind.BET });
    const due = new Date();
    await orm.em.getConnection().execute(
      'UPDATE wager_transactions SET next_reference_attempt_at = ? WHERE id = ?',
      [due, pending.id],
    );
    const first = new PendingReferenceWorkerService(orm, new ReprocessPendingReferenceUseCase(orm));
    const second = new PendingReferenceWorkerService(orm, new ReprocessPendingReferenceUseCase(orm));

    const claimed = await Promise.all([
      first.processDueOnce(due, 1),
      second.processDueOnce(due, 1),
    ]);

    expect(claimed.reduce((total, count) => total + count, 0)).toBe(1);
    expect(await orm.em.fork().count(WalletLedgerEntryEntity, {
      transaction: { id: pending.id },
    })).toBe(1);
  });

  it('rejects an exhausted pending reference and emits the rejection event', async () => {
    const pending = await createPendingRefund();
    const due = new Date();
    await orm.em.getConnection().execute(
      `UPDATE wager_transactions
       SET reference_attempts = ?, next_reference_attempt_at = ?
       WHERE id = ?`,
      [MAX_PENDING_REFERENCE_ATTEMPTS - 1, due, pending.id],
    );
    const worker = new PendingReferenceWorkerService(orm, reprocess);

    expect(await worker.processDueOnce(due)).toBe(1);

    const stored = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { id: pending.id });
    expect(stored.status).toBe(WagerTransactionStatusEntity.REJECTED);
    expect(stored.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(stored.referenceAttempts).toBe(MAX_PENDING_REFERENCE_ATTEMPTS);
    expect(stored.nextReferenceAttemptAt).toBeNull();
    expect(await orm.em.fork().count(OutboxMessageEntity, {
      aggregateId: pending.id,
      eventType: 'WagerTransactionRejected',
    })).toBe(1);
  });

  async function createPendingRefund() {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-pending-worker-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-pending-worker',
      currency: 'BRL',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: '25.00',
      referenceExternalTransactionId: randomUUID(),
    };
    const result = await submit.execute({ ...input, kind: WagerTransactionKind.REFUND });
    return { ...result, input: {
      ...input,
      externalTransactionId: input.referenceExternalTransactionId,
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId: undefined,
    } };
  }
});
