import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ columnType: 'varchar(255)' })
  eventType!: string;

  @Property({ columnType: 'varchar(255)' })
  aggregateType!: string;

  @Property({ columnType: 'varchar(255)' })
  aggregateId!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ columnType: 'varchar(32)', default: 'PENDING' })
  status!: string;

  @Property({ default: 0 })
  attempts!: number;

  @Property({ columnType: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  nextAttemptAt!: Date;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Property({ columnType: 'timestamptz', defaultRaw: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
