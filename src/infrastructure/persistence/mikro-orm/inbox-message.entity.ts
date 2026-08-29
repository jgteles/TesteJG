import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ columnType: 'varchar(255)' })
  consumerName!: string;

  @Property({ columnType: 'varchar(255)' })
  messageId!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ columnType: 'varchar(32)', default: 'NEW' })
  status!: string;

  @Property({ default: 0 })
  attempts!: number;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
