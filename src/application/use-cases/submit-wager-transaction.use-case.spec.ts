import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import {
  WagerTransactionEntity,
  WagerTransactionKindEntity,
  WagerTransactionStatusEntity,
} from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
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

  it('persists an out-of-order REFUND and ROLLBACK as PENDING_REFERENCE without changing balance or ledger', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-pending-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-pending',
      currency: 'BRL',
    };

    const refund = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: `missing-bet-${randomUUID()}`,
    });
    const rollback = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.ROLLBACK,
      amount: '10.00',
      referenceExternalTransactionId: `missing-win-${randomUUID()}`,
    });

    expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(rollback.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(refund.balance.amount).toBe('100.00');
    expect(rollback.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBeUndefined();
    expect(rollback.referenceTransactionId).toBeUndefined();

    const readEm = orm.em.fork();
    const storedWallet = await readEm.findOneOrFail(WalletEntity, { id: wallet.id });
    const reversalLedgerCount = await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: { $in: [refund.id, rollback.id] } },
    });
    expect(storedWallet.balanceAmount).toBe('100.00');
    expect(storedWallet.version).toBe(1);
    expect(reversalLedgerCount).toBe(0);
  });

  it('serializes concurrent REFUNDs of the same reference and processes exactly one', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-concurrent-refund-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-concurrent-refund',
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
    const refundInputs = [randomUUID(), randomUUID()].map((externalTransactionId) => ({
      ...base,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: betExternalId,
    }));

    const results = await Promise.all(refundInputs.map((input) => submit.execute(input)));

    expect(results.filter((result) => result.status === WagerTransactionStatus.PROCESSED)).toHaveLength(1);
    expect(results.filter((result) => result.status === WagerTransactionStatus.REJECTED)).toHaveLength(1);
    expect(results.find((result) => result.status === WagerTransactionStatus.REJECTED)?.failureCode)
      .toBe('REFERENCE_ALREADY_REVERSED');

    const readEm = orm.em.fork();
    const storedWallet = await readEm.findOneOrFail(WalletEntity, { id: wallet.id });
    const processedRefunds = await readEm.count(WagerTransactionEntity, {
      referenceTransactionId: bet.id,
      kind: WagerTransactionKindEntity.REFUND,
      status: WagerTransactionStatusEntity.PROCESSED,
    });
    const refundLedgers = await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: { $in: results.map((result) => result.id) } },
    });
    expect(storedWallet.balanceAmount).toBe('100.00');
    expect(processedRefunds).toBe(1);
    expect(refundLedgers).toBe(1);
  });

  it('rejects a reversal whose amount differs from the reference without writing ledger', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-amount-mismatch-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-amount-mismatch',
      currency: 'BRL',
    };
    const betExternalId = randomUUID();
    await submit.execute({
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
      amount: '20.00',
      referenceExternalTransactionId: betExternalId,
    });

    expect(refund.status).toBe(WagerTransactionStatus.REJECTED);
    expect(refund.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect(refund.balance.amount).toBe('75.00');
    const readEm = orm.em.fork();
    expect(await readEm.count(WalletLedgerEntryEntity, { transaction: { id: refund.id } })).toBe(0);
  });

  it('rejects references with incompatible player, wallet, currency, or round', async () => {
    const providerId = `provider-context-mismatch-${randomUUID()}`;
    const roundId = randomUUID();
    const playerA = randomUUID();
    const playerB = randomUUID();
    const walletA = await createWallet.execute({
      playerId: playerA,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletB = await createWallet.execute({
      playerId: playerB,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletUsd = await createWallet.execute({
      playerId: playerA,
      currency: 'USD',
      initialBalance: { amount: '100.00', currency: 'USD' },
    });
    const betExternalId = randomUUID();
    await submit.execute({
      walletId: walletA.id,
      playerId: playerA,
      providerId,
      roundId,
      gameId: 'game-context',
      currency: 'BRL',
      externalTransactionId: betExternalId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
    });

    const wrongPlayerAndWallet = await submit.execute({
      walletId: walletB.id,
      playerId: playerB,
      providerId,
      roundId,
      gameId: 'game-context',
      currency: 'BRL',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: betExternalId,
    });
    const wrongCurrency = await submit.execute({
      walletId: walletUsd.id,
      playerId: playerA,
      providerId,
      roundId,
      gameId: 'game-context',
      currency: 'USD',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: betExternalId,
    });
    const wrongRound = await submit.execute({
      walletId: walletA.id,
      playerId: playerA,
      providerId,
      roundId: randomUUID(),
      gameId: 'game-context',
      currency: 'BRL',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: betExternalId,
    });

    for (const result of [wrongPlayerAndWallet, wrongCurrency, wrongRound]) {
      expect(result.status).toBe(WagerTransactionStatus.REJECTED);
      expect(result.failureCode).toBe('REFERENCE_CONTEXT_MISMATCH');
    }
    const readEm = orm.em.fork();
    expect(await readEm.count(WalletLedgerEntryEntity, {
      transaction: { id: { $in: [wrongPlayerAndWallet.id, wrongCurrency.id, wrongRound.id] } },
    })).toBe(0);
  });

  it('rejects REFUND when the referenced transaction is not a BET', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-refund-type-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-refund-type',
      currency: 'BRL',
    };
    const winExternalId = randomUUID();
    await submit.execute({
      ...base,
      externalTransactionId: winExternalId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.WIN,
      amount: '25.00',
    });

    const refund = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: winExternalId,
    });

    expect(refund.status).toBe(WagerTransactionStatus.REJECTED);
    expect(refund.failureCode).toBe('REFERENCE_TYPE_MISMATCH');
    expect(refund.balance.amount).toBe('125.00');
    const readEm = orm.em.fork();
    expect(await readEm.count(WalletLedgerEntryEntity, { transaction: { id: refund.id } })).toBe(0);
  });

  it('rejects a ROLLBACK that would make the wallet balance negative', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-negative-rollback-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-negative-rollback',
      currency: 'BRL',
    };
    const winExternalId = randomUUID();
    await submit.execute({
      ...base,
      externalTransactionId: winExternalId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.WIN,
      amount: '50.00',
    });
    await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '50.00',
    });

    const rollback = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.ROLLBACK,
      amount: '50.00',
      referenceExternalTransactionId: winExternalId,
    });

    expect(rollback.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rollback.failureCode).toBe('REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE');
    expect(rollback.balance.amount).toBe('0.00');
    const readEm = orm.em.fork();
    const storedWallet = await readEm.findOneOrFail(WalletEntity, { id: wallet.id });
    expect(storedWallet.balanceAmount).toBe('0.00');
    expect(await readEm.count(WalletLedgerEntryEntity, { transaction: { id: rollback.id } })).toBe(0);
  });
});
