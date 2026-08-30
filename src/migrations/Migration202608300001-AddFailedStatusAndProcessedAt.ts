import { Migration } from '@mikro-orm/migrations';

export default class AddFailedStatusAndProcessedAt extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN processed_at TIMESTAMPTZ;
    `);
    this.addSql(`
      UPDATE wager_transactions
      SET processed_at = updated_at
      WHERE status = 'PROCESSED';
    `);
  }

  async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN processed_at;');
  }
}
