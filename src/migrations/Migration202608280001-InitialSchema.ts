import { Migration } from '@mikro-orm/migrations';

export default class InitialSchema extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id VARCHAR(36) NOT NULL,
        player_id VARCHAR(255) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount NUMERIC(19,2) NOT NULL DEFAULT 0,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT wallets_pkey PRIMARY KEY (id),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id VARCHAR(36) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        provider_id VARCHAR(255) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        wallet_id VARCHAR(36) NOT NULL,
        player_id VARCHAR(255) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        amount NUMERIC(19,2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(255),
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        payload_hash VARCHAR(128) NOT NULL,
        failure_code VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT wager_transactions_pkey PRIMARY KEY (id),
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wager_transactions_provider_reference
        ON wager_transactions (provider_id, reference_external_transaction_id);
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id VARCHAR(36) NOT NULL,
        wallet_id VARCHAR(36) NOT NULL,
        transaction_id VARCHAR(36) NOT NULL,
        entry_type VARCHAR(32) NOT NULL,
        amount NUMERIC(19,2) NOT NULL,
        balance_before NUMERIC(19,2) NOT NULL,
        balance_after NUMERIC(19,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT wallet_ledger_entries_pkey PRIMARY KEY (id),
        CONSTRAINT wallet_ledger_entries_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wallet_ledger_entries_transaction_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),
        CONSTRAINT wallet_ledger_entries_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wallet_ledger_entries_balance_check CHECK (balance_after = balance_before + amount)
      );
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        id VARCHAR(36) NOT NULL,
        consumer_name VARCHAR(255) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'NEW',
        attempts INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (id),
        CONSTRAINT inbox_messages_consumer_message_unique UNIQUE (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id VARCHAR(36) NOT NULL,
        event_type VARCHAR(255) NOT NULL,
        aggregate_type VARCHAR(255) NOT NULL,
        aggregate_id VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        attempts INT NOT NULL DEFAULT 0,
        published_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT outbox_messages_pkey PRIMARY KEY (id)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_messages_publish_queue
        ON outbox_messages (published_at, next_attempt_at);
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
