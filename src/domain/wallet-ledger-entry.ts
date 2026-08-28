import { Money } from './money';
import { CurrencyMismatchError, LedgerBalanceMismatchError } from './errors';

export type LedgerEntryType = 'OPENING' | 'CREDIT' | 'DEBIT';

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  type: LedgerEntryType;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  type: LedgerEntryType;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly _id: string;
  private readonly _walletId: string;
  private readonly _transactionId: string;
  private readonly _type: LedgerEntryType;
  private readonly _amount: Money;
  private readonly _balanceBefore: Money;
  private readonly _balanceAfter: Money;
  private readonly _createdAt: Date;

  private constructor(props: WalletLedgerEntryProps) {
    this._id = props.id;
    this._walletId = props.walletId;
    this._transactionId = props.transactionId;
    this._type = props.type;
    this._amount = props.amount;
    this._balanceBefore = props.balanceBefore;
    this._balanceAfter = props.balanceAfter;
    this._createdAt = props.createdAt ?? new Date();
  }

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    const amountCurrency = props.amount.currency;

    if (props.balanceBefore.currency !== amountCurrency || props.balanceAfter.currency !== amountCurrency) {
      throw new CurrencyMismatchError(props.balanceBefore.currency, amountCurrency);
    }

    const expectedBalanceAfter = (() => {
      switch (props.type) {
        case 'OPENING':
        case 'CREDIT':
          return props.balanceBefore.add(props.amount);
        case 'DEBIT':
          return props.balanceBefore.subtract(props.amount);
        default:
          throw new Error(`Unsupported ledger entry type: ${props.type}`);
      }
    })();

    if (!props.balanceAfter.equals(expectedBalanceAfter)) {
      throw new LedgerBalanceMismatchError();
    }

    return new WalletLedgerEntry(props);
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({
      id: state.id,
      walletId: state.walletId,
      transactionId: state.transactionId,
      type: state.type,
      amount: state.amount,
      balanceBefore: state.balanceBefore,
      balanceAfter: state.balanceAfter,
      createdAt: state.createdAt,
    });
  }

  get id(): string { return this._id; }
  get walletId(): string { return this._walletId; }
  get transactionId(): string { return this._transactionId; }
  get type(): LedgerEntryType { return this._type; }
  get amount(): Money { return this._amount; }
  get balanceBefore(): Money { return this._balanceBefore; }
  get balanceAfter(): Money { return this._balanceAfter; }
  get createdAt(): Date { return this._createdAt; }
}
