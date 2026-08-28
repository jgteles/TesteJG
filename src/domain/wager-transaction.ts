import { Money } from './money';

export enum WagerTransactionKind {
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
}

export enum WagerTransactionStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
}

export interface WagerTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  amount: Money;
  status?: WagerTransactionStatus;
  failureCode?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly kind: WagerTransactionKind;
  public readonly amount: Money;
  public status: WagerTransactionStatus;
  public failureCode?: string;
  public readonly createdAt: Date;
  public updatedAt: Date;

  private constructor(props: WagerTransactionProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.playerId = props.playerId;
    this.kind = props.kind;
    this.amount = props.amount;
    this.status = props.status ?? WagerTransactionStatus.PENDING;
    this.failureCode = props.failureCode;
    this.createdAt = props.createdAt ?? new Date();
    this.updatedAt = props.updatedAt ?? this.createdAt;
  }

  static create(props: WagerTransactionProps): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new Error(`Unsupported wager transaction kind: ${props.kind}`);
    }

    return new WagerTransaction(props);
  }

  markProcessed(): WagerTransaction {
    if (this.status !== WagerTransactionStatus.PENDING) {
      throw new Error(`Cannot process a transaction in status ${this.status}`);
    }

    this.status = WagerTransactionStatus.PROCESSED;
    this.updatedAt = new Date();
    return this;
  }

  markRejected(failureCode: string): WagerTransaction {
    if (this.status !== WagerTransactionStatus.PENDING) {
      throw new Error(`Cannot reject a transaction in status ${this.status}`);
    }

    this.status = WagerTransactionStatus.REJECTED;
    this.failureCode = failureCode;
    this.updatedAt = new Date();
    return this;
  }
}
