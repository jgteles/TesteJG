import { Migration } from '@mikro-orm/migrations';

export default class AddReversalReferences extends Migration {
  async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN reference_transaction_id VARCHAR(36);');
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_reference_fk
      FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id);
    `);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_reference_required_check
      CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL);
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_processed_reversal_unique
      ON wager_transactions (reference_transaction_id, kind)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP INDEX wager_transactions_processed_reversal_unique;');
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_reference_required_check;');
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_reference_fk;');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN reference_transaction_id;');
  }
}
