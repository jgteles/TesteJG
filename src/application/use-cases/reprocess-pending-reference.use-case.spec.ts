import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import { WagerTransactionEntity, WagerTransactionStatusEntity } from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { ReprocessPendingReferenceUseCase } from './reprocess-pending-reference.use-case';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

describe('ReprocessPendingReferenceUseCase', () => {
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

  it('processes the same pending REFUND after its BET arrives and does not credit it twice', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const betExternalId = randomUUID();
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-reprocess-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-reprocess',
      currency: 'BRL',
    };

    const pendingRefund = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: betExternalId,
    });
    expect(pendingRefund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(pendingRefund.balance.amount).toBe('100.00');

    const bet = await submit.execute({
      ...base,
      externalTransactionId: betExternalId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
    });
    expect(bet.balance.amount).toBe('75.00');

    const processed = await reprocess.execute(pendingRefund.id);
    expect(processed.id).toBe(pendingRefund.id);
    expect(processed.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(processed.balance.amount).toBe('100.00');
    expect(processed.referenceTransactionId).toBe(bet.id);
    expect(processed.reprocessed).toBe(true);

    const replay = await reprocess.execute(pendingRefund.id);
    expect(replay.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(replay.balance.amount).toBe('100.00');
    expect(replay.referenceTransactionId).toBe(bet.id);
    expect(replay.reprocessed).toBe(false);

    const readEm = orm.em.fork();
    const storedRefund = await readEm.findOneOrFail(WagerTransactionEntity, { id: pendingRefund.id });
    const storedWallet = await readEm.findOneOrFail(WalletEntity, { id: wallet.id });
    const refundLedgers = await readEm.find(WalletLedgerEntryEntity, {
      transaction: { id: pendingRefund.id },
    });
    expect(storedRefund.status).toBe(WagerTransactionStatusEntity.PROCESSED);
    expect(storedRefund.referenceTransactionId).toBe(bet.id);
    expect(storedWallet.balanceAmount).toBe('100.00');
    expect(refundLedgers).toHaveLength(1);
    expect(refundLedgers[0].entryType).toBe(WalletLedgerEntryType.CREDIT);
    expect(refundLedgers[0].amount).toBe('25.00');
    expect(refundLedgers[0].balanceBefore).toBe('75.00');
    expect(refundLedgers[0].balanceAfter).toBe('100.00');
  });

  it('keeps PENDING_REFERENCE unchanged while the reference is still absent', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const pendingRollback = await submit.execute({
      walletId: wallet.id,
      playerId,
      providerId: `provider-still-missing-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-still-missing',
      currency: 'BRL',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.ROLLBACK,
      amount: '10.00',
      referenceExternalTransactionId: `missing-${randomUUID()}`,
    });

    const result = await reprocess.execute(pendingRollback.id);

    expect(result.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(result.balance.amount).toBe('100.00');
    expect(result.referenceTransactionId).toBeUndefined();
    expect(result.reprocessed).toBe(false);
    const readEm = orm.em.fork();
    const storedWallet = await readEm.findOneOrFail(WalletEntity, { id: wallet.id });
    expect(storedWallet.balanceAmount).toBe('100.00');
    expect(storedWallet.version).toBe(1);
    expect(await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: pendingRollback.id },
    })).toBe(0);
  });
});
