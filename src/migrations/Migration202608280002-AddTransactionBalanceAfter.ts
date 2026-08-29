import { Migration } from '@mikro-orm/migrations';

export default class AddTransactionBalanceAfter extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN balance_after NUMERIC(19,2);
    `);
    this.addSql(`
      UPDATE wager_transactions AS transaction
      SET balance_after = wallet.balance_amount
      FROM wallets AS wallet
      WHERE wallet.id = transaction.wallet_id;
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
      ALTER COLUMN balance_after SET NOT NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN balance_after;');
  }
}
