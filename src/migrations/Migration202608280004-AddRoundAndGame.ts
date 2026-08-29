import { Migration } from '@mikro-orm/migrations';

export default class AddRoundAndGame extends Migration {
  async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN round_id VARCHAR(255);');
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN game_id VARCHAR(255);');
    this.addSql(`
      UPDATE wager_transactions
      SET round_id = 'legacy-' || id, game_id = 'legacy-unknown'
      WHERE kind <> 'OPENING';
    `);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_round_game_check
      CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL));
    `);
  }

  async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_round_game_check;');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN game_id;');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN round_id;');
  }
}
