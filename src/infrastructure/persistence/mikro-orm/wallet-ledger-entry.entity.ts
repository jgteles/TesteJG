import type { Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';

export enum WalletLedgerEntryType {
  OPENING = 'OPENING',
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, { fieldName: 'wallet_id' })
  wallet!: Rel<WalletEntity>;

  @ManyToOne(() => WagerTransactionEntity, { fieldName: 'transaction_id' })
  transaction!: Rel<WagerTransactionEntity>;

  @Enum(() => WalletLedgerEntryType)
  entryType!: WalletLedgerEntryType;

  @Property({ columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ columnType: 'numeric(19,2)' })
  balanceBefore!: string;

  @Property({ columnType: 'numeric(19,2)' })
  balanceAfter!: string;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
