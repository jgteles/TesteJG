import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
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
});
