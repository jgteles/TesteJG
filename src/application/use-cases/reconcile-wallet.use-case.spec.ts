import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';

describe('ReconcileWalletUseCase', () => {
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let reconcileWallet: ReconcileWalletUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    createWallet = new CreateWalletUseCase(orm);
    reconcileWallet = new ReconcileWalletUseCase(orm);
  });

  afterAll(async () => {
    await orm.close();
  });

  it('reports a wallet whose stored balance matches its ledger as consistent', async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const result = await reconcileWallet.execute(wallet.id);

    expect(result).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });

  it('reports divergence without changing the wallet', async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    await orm.em.getConnection().execute(
      'UPDATE wallets SET balance_amount = ? WHERE id = ?',
      ['90.00', wallet.id],
    );

    const result = await reconcileWallet.execute(wallet.id);
    const storedAfterReconciliation = await orm.em.fork().findOneOrFail(WalletEntity, { id: wallet.id });

    expect(result.storedBalance.amount).toBe('90.00');
    expect(result.calculatedBalance.amount).toBe('100.00');
    expect(result.difference.amount).toBe('10.00');
    expect(result.consistent).toBe(false);
    expect(storedAfterReconciliation.balanceAmount).toBe('90.00');
  });

  it('keeps monetary calculations as exact decimal strings', async () => {
    const wallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '9007199254740991.01', currency: 'BRL' },
    });

    const result = await reconcileWallet.execute(wallet.id);

    expect(result.storedBalance.amount).toBe('9007199254740991.01');
    expect(result.calculatedBalance.amount).toBe('9007199254740991.01');
    expect(typeof result.storedBalance.amount).toBe('string');
    expect(typeof result.calculatedBalance.amount).toBe('string');
    expect(typeof result.difference.amount).toBe('string');
  });
});
