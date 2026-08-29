import { Migration } from '@mikro-orm/migrations';

export default class AddIdempotencyKeys extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE idempotency_keys (
        key VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT idempotency_keys_pkey PRIMARY KEY (key)
      );
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS idempotency_keys;');
  }
}
