import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NotFoundException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import config from '../../mikro-orm.config';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { QueryWalletsUseCase } from './query-wallets.use-case';
import { QueryWagerTransactionsUseCase } from './query-wager-transactions.use-case';

describe('mandatory GET queries', () => {
  let orm: MikroORM;
  let walletQueries: QueryWalletsUseCase;
  let transactionQueries: QueryWagerTransactionsUseCase;
  let walletId: string;
  let playerId: string;
  let transactionId: string;
  let providerId: string;
  let externalTransactionId: string;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();

    walletQueries = new QueryWalletsUseCase(orm);
    transactionQueries = new QueryWagerTransactionsUseCase(orm);
    playerId = randomUUID();
    providerId = `provider-query-${randomUUID()}`;
    externalTransactionId = randomUUID();

    const wallet = await new CreateWalletUseCase(orm).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    walletId = wallet.id;

    const transaction = await new SubmitWagerTransactionUseCase(orm).execute({
      walletId,
      playerId,
      providerId,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
      currency: 'BRL',
    });
    transactionId = transaction.transactionId;
  });

  afterAll(async () => {
    await orm.close();
  });

  it('returns an existing wallet with money serialized as a string', async () => {
    const wallet = await walletQueries.getWallet(walletId);

    expect(wallet.id).toBe(walletId);
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(typeof wallet.balance.amount).toBe('string');
  });

  it('returns HTTP 404 semantics for a missing wallet', async () => {
    try {
      await walletQueries.getWallet(randomUUID());
      throw new Error('Expected query to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(404);
    }
  });

  it('paginates the ledger with a stable opaque cursor and no duplicated entries', async () => {
    const firstPage = await walletQueries.getLedger(walletId, undefined, '1');

    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextCursor).toBeString();
    expect(firstPage.nextCursor).not.toContain(firstPage.entries[0].id);
    expect(typeof firstPage.entries[0].money.amount).toBe('string');
    expect(typeof firstPage.entries[0].balanceBefore.amount).toBe('string');
    expect(typeof firstPage.entries[0].balanceAfter.amount).toBe('string');

    const secondPage = await walletQueries.getLedger(walletId, firstPage.nextCursor!, '1');

    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0].id).not.toBe(firstPage.entries[0].id);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('finds a transaction by its internal id with persisted monetary values', async () => {
    const transaction = await transactionQueries.getById(transactionId);

    expect(transaction.transactionId).toBe(transactionId);
    expect(transaction.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(transaction.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(typeof transaction.money.amount).toBe('string');
    expect(typeof transaction.balance.amount).toBe('string');
  });

  it('finds a transaction only by the provider and external id combination', async () => {
    const transaction = await transactionQueries.getByProviderExternalId(providerId, externalTransactionId);

    expect(transaction.transactionId).toBe(transactionId);

    await expect(
      transactionQueries.getByProviderExternalId(`${providerId}-other`, externalTransactionId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns HTTP 404 semantics for a missing transaction', async () => {
    try {
      await transactionQueries.getById(randomUUID());
      throw new Error('Expected query to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(404);
    }
  });
});
