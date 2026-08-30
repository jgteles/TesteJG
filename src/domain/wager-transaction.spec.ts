import { describe, expect, it } from 'bun:test';
import { Money } from './money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

describe('WagerTransaction', () => {
  it('marks pending transaction as processed', () => {
    const transaction = WagerTransaction.create({
      id: 'tx-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      roundId: 'round-1',
      gameId: 'game-1',
      idempotencyKey: 'idem-1',
      payloadHash: 'hash-1',
      kind: WagerTransactionKind.BET,
      amount: Money.from({ amount: '10.00', currency: 'BRL' }),
      currency: 'BRL',
    });

    const processedAt = new Date('2026-08-30T12:00:00.000Z');
    transaction.markProcessed(undefined, processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.processedAt).toEqual(processedAt);
  });

  it('rejects a transaction not in pending state', () => {
    const transaction = WagerTransaction.create({
      id: 'tx-2',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-1',
      externalTransactionId: 'ext-2',
      roundId: 'round-2',
      gameId: 'game-1',
      idempotencyKey: 'idem-2',
      payloadHash: 'hash-2',
      kind: WagerTransactionKind.WIN,
      amount: Money.from({ amount: '20.00', currency: 'BRL' }),
      currency: 'BRL',
      status: WagerTransactionStatus.PROCESSED,
    });

    expect(() => transaction.markRejected('INSUFFICIENT_FUNDS')).toThrow('Cannot transition');
  });

  it('requires a provider reference for refunds and rollbacks', () => {
    expect(() => WagerTransaction.create({
      id: 'tx-refund', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-1',
      externalTransactionId: 'ext-refund', roundId: 'round-1', gameId: 'game-1',
      idempotencyKey: 'idem-refund', payloadHash: 'hash-refund', kind: WagerTransactionKind.REFUND,
      amount: Money.from({ amount: '10.00', currency: 'BRL' }), currency: 'BRL',
    })).toThrow('requires a referenceExternalTransactionId');
  });

  it('moves an out-of-order reversal through pending reference to processed', () => {
    const transaction = WagerTransaction.create({
      id: 'tx-rollback', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-1',
      externalTransactionId: 'ext-rollback', roundId: 'round-1', gameId: 'game-1',
      idempotencyKey: 'idem-rollback', payloadHash: 'hash-rollback', kind: WagerTransactionKind.ROLLBACK,
      amount: Money.from({ amount: '10.00', currency: 'BRL' }), currency: 'BRL',
      referenceExternalTransactionId: 'ext-bet',
    });

    transaction.markPendingReference().markProcessed('tx-bet');

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.referenceTransactionId).toBe('tx-bet');
  });

  it('marks a pending transaction as failed for a permanent infrastructure error', () => {
    const transaction = WagerTransaction.create({
      id: 'tx-failed', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-1',
      externalTransactionId: 'ext-failed', roundId: 'round-1', gameId: 'game-1',
      idempotencyKey: 'idem-failed', payloadHash: 'hash-failed', kind: WagerTransactionKind.BET,
      amount: Money.from({ amount: '10.00', currency: 'BRL' }), currency: 'BRL',
    });

    transaction.markFailed('PERMANENT_INFRASTRUCTURE_ERROR');

    expect(transaction.status).toBe(WagerTransactionStatus.FAILED);
    expect(transaction.failureCode).toBe('PERMANENT_INFRASTRUCTURE_ERROR');
    expect(transaction.processedAt).toBeUndefined();
    expect(() => transaction.markProcessed()).toThrow('Cannot transition');
  });

  it('keeps business rejection distinct from infrastructure failure', () => {
    const transaction = WagerTransaction.create({
      id: 'tx-rejected', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-1',
      externalTransactionId: 'ext-rejected', roundId: 'round-1', gameId: 'game-1',
      idempotencyKey: 'idem-rejected', payloadHash: 'hash-rejected', kind: WagerTransactionKind.BET,
      amount: Money.from({ amount: '10.00', currency: 'BRL' }), currency: 'BRL',
    });

    transaction.markRejected('INSUFFICIENT_FUNDS');

    expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(transaction.processedAt).toBeUndefined();
  });

  it('keeps a missing reference pending while it is still reprocessable', () => {
    const transaction = WagerTransaction.create({
      id: 'tx-pending-reference', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-1',
      externalTransactionId: 'ext-pending-reference', roundId: 'round-1', gameId: 'game-1',
      idempotencyKey: 'idem-pending-reference', payloadHash: 'hash-pending-reference',
      kind: WagerTransactionKind.REFUND,
      amount: Money.from({ amount: '10.00', currency: 'BRL' }), currency: 'BRL',
      referenceExternalTransactionId: 'missing-bet',
    });

    transaction.markPendingReference();

    expect(transaction.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(transaction.processedAt).toBeUndefined();
  });
});
