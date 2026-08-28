import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
export class Wallet {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ columnType: 'varchar(255)' })
  playerId!: string;

  @Property({ columnType: 'varchar(3)' })
  currency!: string;

  @Property({ columnType: 'numeric(19,2)', default: 0 })
  balanceAmount!: string;

  @Property({ default: 1 })
  version!: number;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
