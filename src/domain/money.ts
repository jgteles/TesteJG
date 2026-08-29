import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private static readonly amountPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = props.currency.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError('Currency must be a three-letter ISO-4217 code');
    }

    if (!Money.amountPattern.test(props.amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal with at most two places');
    }

    return new Money(new Decimal(props.amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromInternal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromInternal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromInternal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private static fromInternal(value: Decimal, currency: string): Money {
    if (!value.isFinite() || value.decimalPlaces() > 2) {
      throw new InvalidMoneyError('Money operation produced an invalid scale');
    }

    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
