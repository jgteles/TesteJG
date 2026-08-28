import { Money } from './money';

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

export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly type: LedgerEntryType;
  public readonly amount: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  public readonly createdAt: Date;

  private constructor(props: WalletLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.type = props.type;
    this.amount = props.amount;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.createdAt = props.createdAt ?? new Date();
  }

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    const amountCurrency = props.amount.currency;

    if (props.balanceBefore.currency !== amountCurrency || props.balanceAfter.currency !== amountCurrency) {
      throw new Error('Currency mismatch in ledger entry');
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
      throw new Error('Ledger balance verification failed');
    }

    return new WalletLedgerEntry(props);
  }
}
