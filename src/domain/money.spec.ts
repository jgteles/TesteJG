import { Money } from './money';

describe('Money', () => {
  it('normalizes amounts to two decimal places', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('performs exact decimal arithmetic', () => {
    const result = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );

    expect(result.toString()).toBe('0.30');
  });

  it.each(['', '1.234', '-1.00', '1e2', 'Infinity', 'NaN'])('rejects invalid amount %s', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
  });

  it('rejects operations across currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow('Currency mismatch');
  });

  it('supports negative intermediate results without accepting negative input', () => {
    const result = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '15.00', currency: 'BRL' }),
    );

    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-5.00');
  });
});
