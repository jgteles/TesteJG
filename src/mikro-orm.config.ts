import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { InboxMessageEntity } from './infrastructure/persistence/mikro-orm/inbox-message.entity';
import { OutboxMessageEntity } from './infrastructure/persistence/mikro-orm/outbox-message.entity';
import { WagerTransactionEntity } from './infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import { WalletEntity } from './infrastructure/persistence/mikro-orm/wallet.entity';

export default defineConfig({
  driver: PostgreSqlDriver,
  dbName: process.env.POSTGRES_DB ?? 'wagering',
  user: process.env.POSTGRES_USER ?? 'wagering',
  password: process.env.POSTGRES_PASSWORD ?? 'wagering',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  forceUtcTimezone: true,
  extensions: [Migrator],
  migrations: {
    tableName: 'mikro_orm_migrations',
    path: 'dist/migrations',
    pathTs: 'src/migrations',
    transactional: true,
    disableForeignKeys: false,
    emit: 'ts',
  },
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  allowGlobalContext: true,
});
