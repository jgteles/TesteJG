import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import {
  WagerTransactionEntity,
  WagerTransactionKindEntity,
  WagerTransactionStatusEntity,
} from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

describe('WagerTransaction status persistence', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
  });

  afterAll(async () => {
    await orm.close();
  });

  it('persists processedAt when a transaction becomes PROCESSED', async () => {
    const playerId = randomUUID();
    const wallet = await new CreateWalletUseCase(orm).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const result = await new SubmitWagerTransactionUseCase(orm).execute({
      walletId: wallet.id,
      playerId,
      providerId: `provider-processed-at-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      roundId: randomUUID(),
      gameId: 'game-processed-at',
      kind: WagerTransactionKind.BET,
      amount: '10.00',
      currency: 'BRL',
    });

    const stored = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { id: result.id });
    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.processedAt).toBeInstanceOf(Date);
    expect(stored.processedAt).toEqual(result.processedAt);
  });

  it('persists FAILED without assigning processedAt', async () => {
    const playerId = randomUUID();
    const walletResult = await new CreateWalletUseCase(orm).execute({ playerId });
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletEntity, { id: walletResult.id });
    const transactionId = randomUUID();

    em.persist(em.create(WagerTransactionEntity, {
      id: transactionId,
      wallet,
      playerId,
      providerId: `provider-failed-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'game-failed',
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKindEntity.BET,
      amount: '10.00',
      currency: 'BRL',
      status: WagerTransactionStatusEntity.FAILED,
      payloadHash: randomUUID(),
      failureCode: 'PERMANENT_INFRASTRUCTURE_ERROR',
      referenceAttempts: 0,
      balanceAfter: wallet.balanceAmount,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await em.flush();

    const stored = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { id: transactionId });
    expect(stored.status).toBe(WagerTransactionStatusEntity.FAILED);
    expect(stored.failureCode).toBe('PERMANENT_INFRASTRUCTURE_ERROR');
    expect(stored.processedAt).toBeNull();
  });
});
