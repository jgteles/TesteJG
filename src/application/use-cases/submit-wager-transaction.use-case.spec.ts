import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

describe('SubmitWagerTransactionUseCase', () => {
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let submit: SubmitWagerTransactionUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    createWallet = new CreateWalletUseCase(orm);
    submit = new SubmitWagerTransactionUseCase(orm);
  });

  afterAll(async () => {
    await orm.close();
  });

  it('processes BET, WIN and LOSS with the expected balance effects', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const base = {
      walletId: wallet.id,
      playerId,
      providerId: 'provider-basic-flow',
      roundId: randomUUID(),
      gameId: 'game-basic-flow',
      currency: 'BRL',
    };

    const bet = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
    });
    const win = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.WIN,
      amount: '10.00',
    });
    const loss = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.LOSS,
      amount: '25.00',
    });

    expect(bet.balance.amount).toBe('75.00');
    expect(win.balance.amount).toBe('85.00');
    expect(loss.balance.amount).toBe('85.00');
  });

  it('serializes two concurrent bets against the same wallet', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const providerId = 'provider-concurrency';

    const results = await Promise.all([
      submit.execute({
        walletId: wallet.id,
        playerId,
        providerId,
        roundId: randomUUID(),
        gameId: 'game-concurrency',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        kind: WagerTransactionKind.BET,
        amount: '80.00',
        currency: 'BRL',
      }),
      submit.execute({
        walletId: wallet.id,
        playerId,
        providerId,
        roundId: randomUUID(),
        gameId: 'game-concurrency',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        kind: WagerTransactionKind.BET,
        amount: '80.00',
        currency: 'BRL',
      }),
    ]);

    expect(results.filter((result) => result.status === WagerTransactionStatus.PROCESSED)).toHaveLength(1);
    expect(results.filter((result) => result.status === WagerTransactionStatus.REJECTED)).toHaveLength(1);

    const readEm = orm.em.fork();
    const storedWallet = await readEm.findOneOrFail(WalletEntity, { id: wallet.id });
    const debits = await readEm.count(WalletLedgerEntryEntity, {
      wallet: { id: wallet.id },
      entryType: WalletLedgerEntryType.DEBIT,
    });

    expect(storedWallet.balanceAmount).toBe('20.00');
    expect(debits).toBe(1);
  });

  it('applies concurrent retries only once and returns a replay', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const idempotencyKey = randomUUID();
    const input = {
      walletId: wallet.id,
      playerId,
      providerId: 'provider-retry',
      roundId: randomUUID(),
      gameId: 'game-retry',
      externalTransactionId: randomUUID(),
      idempotencyKey,
      kind: WagerTransactionKind.BET,
      amount: '30.00',
      currency: 'BRL',
    };

    const results = await Promise.all([submit.execute(input), submit.execute(input)]);

    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0].id).toBe(results[1].id);
    expect(results[0].balance.amount).toBe('70.00');
    expect(results[1].balance.amount).toBe('70.00');

    const readEm = orm.em.fork();
    const debits = await readEm.count(WalletLedgerEntryEntity, {
      wallet: { id: wallet.id },
      entryType: WalletLedgerEntryType.DEBIT,
    });
    expect(debits).toBe(1);
  });

  it('processes REFUND and ROLLBACK references with inverse ledger entries', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-reversal-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-reversal',
      currency: 'BRL',
    };

    const betExternalId = randomUUID();
    const bet = await submit.execute({
      ...base,
      externalTransactionId: betExternalId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
    });
    const refund = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: betExternalId,
    });

    const winExternalId = randomUUID();
    const win = await submit.execute({
      ...base,
      externalTransactionId: winExternalId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.WIN,
      amount: '10.00',
    });
    const rollback = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.ROLLBACK,
      amount: '10.00',
      referenceExternalTransactionId: winExternalId,
    });

    expect(bet.balance.amount).toBe('75.00');
    expect(refund.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(refund.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(win.balance.amount).toBe('110.00');
    expect(rollback.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(rollback.balance.amount).toBe('100.00');
    expect(rollback.referenceTransactionId).toBe(win.id);

    const readEm = orm.em.fork();
    const storedRefund = await readEm.findOneOrFail(WagerTransactionEntity, { id: refund.id });
    const storedRollback = await readEm.findOneOrFail(WagerTransactionEntity, { id: rollback.id });
    const refundLedger = await readEm.findOneOrFail(WalletLedgerEntryEntity, {
      transaction: { id: refund.id },
    });
    const rollbackLedger = await readEm.findOneOrFail(WalletLedgerEntryEntity, {
      transaction: { id: rollback.id },
    });

    expect(storedRefund.referenceTransactionId).toBe(bet.id);
    expect(storedRollback.referenceTransactionId).toBe(win.id);
    expect(refundLedger.entryType).toBe(WalletLedgerEntryType.CREDIT);
    expect(refundLedger.balanceBefore).toBe('75.00');
    expect(refundLedger.balanceAfter).toBe('100.00');
    expect(rollbackLedger.entryType).toBe(WalletLedgerEntryType.DEBIT);
    expect(rollbackLedger.balanceBefore).toBe('110.00');
    expect(rollbackLedger.balanceAfter).toBe('100.00');
  });
});
