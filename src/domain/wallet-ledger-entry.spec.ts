import { describe, expect, it } from 'bun:test';
import { Money } from './money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

describe('WalletLedgerEntry', () => {
  it('creates a valid credit ledger entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      type: 'CREDIT',
      amount: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '50.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
    });

    expect(entry.type).toBe('CREDIT');
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  it('creates a valid debit ledger entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-2',
      walletId: 'wallet-1',
      transactionId: 'tx-2',
      type: 'DEBIT',
      amount: Money.from({ amount: '12.50', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '75.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '62.50', currency: 'BRL' }),
    });

    expect(entry.balanceAfter.toString()).toBe('62.50');
  });

  it('rejects inconsistent balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-3',
        walletId: 'wallet-1',
        transactionId: 'tx-3',
        type: 'DEBIT',
        amount: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '50.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '35.00', currency: 'BRL' }),
      }),
    ).toThrow('Ledger balance verification failed');
  });
});
