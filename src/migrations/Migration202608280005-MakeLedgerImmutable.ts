import { Migration } from '@mikro-orm/migrations';

export default class MakeLedgerImmutable extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation();');
  }
}
