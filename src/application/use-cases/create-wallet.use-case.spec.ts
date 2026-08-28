import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import {
  WagerTransactionEntity,
  WagerTransactionKindEntity,
} from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import {
  WalletLedgerEntryEntity,
  WalletLedgerEntryType,
} from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import { CreateWalletUseCase } from './create-wallet.use-case';

describe('CreateWalletUseCase', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.getMigrator().up();
  });

  afterAll(async () => {
    await orm.close();
  });

  it('creates an OPENING transaction and matching ledger credit when initial balance is positive', async () => {
    const useCase = new CreateWalletUseCase(orm);

    const result = await useCase.execute({
      playerId: 'player-opening',
      initialBalance: { amount: '25.00', currency: 'BRL' },
    });

    const wallet = await orm.em.findOne(WalletEntity, { id: result.id });
    const openingTransaction = await orm.em.findOne(WagerTransactionEntity, {
      idempotencyKey: `wallet-open:${result.id}`,
    });
    const ledgerEntry = await orm.em.findOne(WalletLedgerEntryEntity, {
      wallet: { id: wallet!.id },
      transaction: { id: openingTransaction!.id },
    });

    expect(wallet?.balanceAmount).toBe('25.00');
    expect(openingTransaction?.kind).toBe(WagerTransactionKindEntity.OPENING);
    expect(ledgerEntry?.entryType).toBe(WalletLedgerEntryType.CREDIT);
    expect(ledgerEntry?.balanceAfter).toBe('25.00');
  });
});
