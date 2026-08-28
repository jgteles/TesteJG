import { describe, expect, it } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';

describe('Wallet', () => {
  it('opens a wallet with initial balance', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('credits and debits money while preserving currency', () => {
    const wallet = Wallet.open({
      id: 'w-2',
      playerId: 'player-2',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }));
    wallet.debit(Money.from({ amount: '15.00', currency: 'BRL' }));

    expect(wallet.balance.toString()).toBe('45.00');
    expect(wallet.version).toBe(3);
  });

  it('prevents debit above balance', () => {
    const wallet = Wallet.open({
      id: 'w-3',
      playerId: 'player-3',
      initialBalance: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(() => wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }))).toThrow('Insufficient funds');
  });

  it('rejects operations in different currencies', () => {
    const wallet = Wallet.open({
      id: 'w-4',
      playerId: 'player-4',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow('Currency mismatch');
  });
});
