import { Money } from './money';
import { InvalidTransactionStateError } from './errors';

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
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  idempotencyKey: string;
  payloadHash: string;
  kind: WagerTransactionKind;
  amount: Money;
  currency: string;
  referenceExternalTransactionId?: string;
  status?: WagerTransactionStatus;
  failureCode?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  idempotencyKey: string;
  payloadHash: string;
  kind: WagerTransactionKind;
  amount: Money;
  currency: string;
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class WagerTransaction {
  private readonly _id: string;
  private readonly _walletId: string;
  private readonly _playerId: string;
  private readonly _providerId: string;
  private readonly _externalTransactionId: string;
  private readonly _roundId: string;
  private readonly _gameId: string;
  private readonly _idempotencyKey: string;
  private readonly _payloadHash: string;
  private readonly _kind: WagerTransactionKind;
  private readonly _amount: Money;
  private readonly _currency: string;
  private readonly _referenceExternalTransactionId?: string;
  private _status: WagerTransactionStatus;
  private _failureCode?: string;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: WagerTransactionProps) {
    this._id = props.id;
    this._walletId = props.walletId;
    this._playerId = props.playerId;
    this._providerId = props.providerId;
    this._externalTransactionId = props.externalTransactionId;
    this._roundId = props.roundId;
    this._gameId = props.gameId;
    this._idempotencyKey = props.idempotencyKey;
    this._payloadHash = props.payloadHash;
    this._kind = props.kind;
    this._amount = props.amount;
    this._currency = props.currency;
    this._referenceExternalTransactionId = props.referenceExternalTransactionId;
    this._status = props.status ?? WagerTransactionStatus.PENDING;
    this._failureCode = props.failureCode;
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? this._createdAt;
  }

  static create(props: WagerTransactionProps): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new Error(`Unsupported wager transaction kind: ${props.kind}`);
    }

    return new WagerTransaction(props);
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      id: state.id,
      walletId: state.walletId,
      playerId: state.playerId,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      roundId: state.roundId,
      gameId: state.gameId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      kind: state.kind,
      amount: state.amount,
      currency: state.currency,
      referenceExternalTransactionId: state.referenceExternalTransactionId,
      status: state.status,
      failureCode: state.failureCode,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }

  get id(): string { return this._id; }
  get walletId(): string { return this._walletId; }
  get playerId(): string { return this._playerId; }
  get providerId(): string { return this._providerId; }
  get externalTransactionId(): string { return this._externalTransactionId; }
  get roundId(): string { return this._roundId; }
  get gameId(): string { return this._gameId; }
  get idempotencyKey(): string { return this._idempotencyKey; }
  get payloadHash(): string { return this._payloadHash; }
  get kind(): WagerTransactionKind { return this._kind; }
  get amount(): Money { return this._amount; }
  get currency(): string { return this._currency; }
  get referenceExternalTransactionId(): string | undefined { return this._referenceExternalTransactionId; }
  get status(): WagerTransactionStatus { return this._status; }
  get failureCode(): string | undefined { return this._failureCode; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }

  markProcessed(): WagerTransaction {
    if (this._status !== WagerTransactionStatus.PENDING) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.PROCESSED);
    }

    this._status = WagerTransactionStatus.PROCESSED;
    this._updatedAt = new Date();
    return this;
  }

  markRejected(failureCode: string): WagerTransaction {
    if (this._status !== WagerTransactionStatus.PENDING) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.REJECTED);
    }

    this._status = WagerTransactionStatus.REJECTED;
    this._failureCode = failureCode;
    this._updatedAt = new Date();
    return this;
  }
}
