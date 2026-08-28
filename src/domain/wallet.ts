import { Money } from './money';

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
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private _createdAt: Date,
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

    const nextBalance = this._balance.subtract(amount);
    if (nextBalance.isNegative()) {
      throw new Error('Insufficient funds');
    }

    this._balance = nextBalance;
    this._version += 1;
    this._updatedAt = new Date();
    return this;
  }

  private assertSameCurrency(amount: Money): void {
    if (this.currency !== amount.currency) {
      throw new Error(`Currency mismatch: ${this.currency} and ${amount.currency}`);
    }
  }
}
