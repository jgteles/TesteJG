import { Migration } from '@mikro-orm/migrations';

export default class AddPendingReferenceRetry extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN reference_attempts INT NOT NULL DEFAULT 0,
      ADD COLUMN next_reference_attempt_at TIMESTAMPTZ;
    `);
    this.addSql(`
      UPDATE wager_transactions
      SET next_reference_attempt_at = NOW()
      WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT wager_transactions_reference_attempts_non_negative
      CHECK (reference_attempts >= 0);
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_retry
      ON wager_transactions (next_reference_attempt_at, id)
      WHERE status = 'PENDING_REFERENCE';
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP INDEX wager_transactions_pending_reference_retry;');
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_reference_attempts_non_negative;');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN next_reference_attempt_at;');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN reference_attempts;');
  }
}
