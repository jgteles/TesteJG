import { Money } from './money';
import { CurrencyMismatchError, InsufficientFundsError } from './errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    private readonly _id: string,
    private readonly _playerId: string,
    private readonly _currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(),
      new Date(),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get id(): string {
    return this._id;
  }

  get playerId(): string {
    return this._playerId;
  }

  get currency(): string {
    return this._currency;
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  credit(amount: Money): Wallet {
    this.assertSameCurrency(amount);
    this._balance = this._balance.add(amount);
    this._version += 1;
    this._updatedAt = new Date();
    return this;
  }

  debit(amount: Money): Wallet {
    this.assertSameCurrency(amount);
    this._balance = Wallet.ensureBalanceAfterDebit(this._balance, amount);
    this._version += 1;
    this._updatedAt = new Date();
    return this;
  }

  private assertSameCurrency(amount: Money): void {
    if (this._currency !== amount.currency) {
      throw new CurrencyMismatchError(this._currency, amount.currency);
    }
  }

  private static ensureBalanceAfterDebit(balance: Money, amount: Money): Money {
    const next = balance.subtract(amount);
    if (next.isNegative()) {
      throw new InsufficientFundsError();
    }
    return next;
  }
}
