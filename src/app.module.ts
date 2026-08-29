import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WalletsController } from './application/controllers/wallets.controller';
import { WagerTransactionsController } from './application/controllers/wager-transactions.controller';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction.use-case';
import { ReprocessPendingReferenceUseCase } from './application/use-cases/reprocess-pending-reference.use-case';
import { HealthController } from './health/health.controller';
import config from './mikro-orm.config';
import { ApplicationExceptionFilter } from './application/filters/application-exception.filter';
import { MigrationRunnerService } from './infrastructure/persistence/migration-runner.service';
import { OutboxPublisherService } from './infrastructure/messaging/outbox-publisher.service';
import { WagerTransactionsConsumerService } from './infrastructure/messaging/wager-transactions-consumer.service';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController, WalletsController, WagerTransactionsController],
  providers: [
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    ReprocessPendingReferenceUseCase,
    MigrationRunnerService,
    OutboxPublisherService,
    WagerTransactionsConsumerService,
    { provide: APP_FILTER, useClass: ApplicationExceptionFilter },
  ],
})
export class AppModule {}
