import type { Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity';

export enum WagerTransactionKindEntity {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
}

export enum WagerTransactionStatusEntity {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
}

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ columnType: 'varchar(255)', unique: true })
  idempotencyKey!: string;

  @Property({ columnType: 'varchar(255)' })
  providerId!: string;

  @Property({ columnType: 'varchar(255)' })
  externalTransactionId!: string;

  @Property({ columnType: 'varchar(255)', nullable: true })
  roundId?: string;

  @Property({ columnType: 'varchar(255)', nullable: true })
  gameId?: string;

  @ManyToOne(() => WalletEntity, { fieldName: 'wallet_id' })
  wallet!: Rel<WalletEntity>;

  @Property({ columnType: 'varchar(255)' })
  playerId!: string;

  @Enum(() => WagerTransactionKindEntity)
  kind!: WagerTransactionKindEntity;

  @Property({ columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ columnType: 'varchar(3)' })
  currency!: string;

  @Property({ columnType: 'varchar(255)', nullable: true })
  referenceExternalTransactionId?: string;

  @Enum(() => WagerTransactionStatusEntity)
  status!: WagerTransactionStatusEntity;

  @Property({ columnType: 'varchar(128)' })
  payloadHash!: string;

  @Property({ columnType: 'varchar(64)', nullable: true })
  failureCode?: string;

  @Property({ columnType: 'numeric(19,2)' })
  balanceAfter!: string;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
