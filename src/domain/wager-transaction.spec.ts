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

    transaction.markProcessed();

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
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
});
