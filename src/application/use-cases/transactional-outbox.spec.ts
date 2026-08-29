import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { OutboxMessageEntity } from '../../infrastructure/persistence/mikro-orm/outbox-message.entity';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { ReprocessPendingReferenceUseCase } from './reprocess-pending-reference.use-case';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

describe('Transactional Outbox', () => {
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

  it('stores processed and balance events for a BET without duplicating them on replay', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-outbox-bet-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'game-outbox-bet',
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
      currency: 'BRL',
    };

    const bet = await submit.execute(input);
    const replay = await submit.execute(input);

    expect(replay.idempotentReplay).toBe(true);
    const events = await orm.em.fork().find(OutboxMessageEntity, { aggregateId: bet.id });
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events.every((event) => event.status === 'PENDING')).toBe(true);
    const balanceEvent = events.find((event) => event.eventType === 'WalletBalanceChanged');
    expect(balanceEvent?.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      aggregateId: bet.id,
      version: 1,
      data: {
        transactionId: bet.id,
        walletId: wallet.id,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('stores only WagerTransactionProcessed for LOSS', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const loss = await submit.execute({
      walletId: wallet.id,
      playerId,
      providerId: `provider-outbox-loss-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'game-outbox-loss',
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.LOSS,
      amount: '25.00',
      currency: 'BRL',
    });

    const events = await orm.em.fork().find(OutboxMessageEntity, { aggregateId: loss.id });
    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionProcessed']);
  });

  it('stores only WagerTransactionRejected for a rejected BET', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const bet = await submit.execute({
      walletId: wallet.id,
      playerId,
      providerId: `provider-outbox-rejected-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      roundId: randomUUID(),
      gameId: 'game-outbox-rejected',
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
      currency: 'BRL',
    });

    expect(bet.status).toBe(WagerTransactionStatus.REJECTED);
    const events = await orm.em.fork().find(OutboxMessageEntity, { aggregateId: bet.id });
    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionRejected']);
    expect(events[0].payload).toMatchObject({
      data: { failureCode: 'INSUFFICIENT_FUNDS' },
    });
  });

  it('stores a pending-reference event for out-of-order REFUND and ROLLBACK', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-outbox-pending-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-outbox-pending',
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
      amount: '25.00',
      referenceExternalTransactionId: `missing-win-${randomUUID()}`,
    });

    const events = await orm.em.fork().find(OutboxMessageEntity, {
      aggregateId: { $in: [refund.id, rollback.id] },
    });
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.eventType === 'WagerTransactionPendingReference')).toBe(true);
  });

  it('stores final processed and balance events when a pending REFUND is reprocessed', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const betExternalId = randomUUID();
    const base = {
      walletId: wallet.id,
      playerId,
      providerId: `provider-outbox-reprocess-${randomUUID()}`,
      roundId: randomUUID(),
      gameId: 'game-outbox-reprocess',
      currency: 'BRL',
    };
    const refund = await submit.execute({
      ...base,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.REFUND,
      amount: '25.00',
      referenceExternalTransactionId: betExternalId,
    });
    await submit.execute({
      ...base,
      externalTransactionId: betExternalId,
      idempotencyKey: randomUUID(),
      kind: WagerTransactionKind.BET,
      amount: '25.00',
    });

    await reprocess.execute(refund.id);
    await reprocess.execute(refund.id);

    const events = await orm.em.fork().find(OutboxMessageEntity, { aggregateId: refund.id });
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const balanceEvent = events.find((event) => event.eventType === 'WalletBalanceChanged');
    expect(balanceEvent?.payload).toMatchObject({
      data: {
        direction: 'CREDIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '75.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
      },
    });
  });
});
