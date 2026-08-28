import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WalletsController } from './application/controllers/wallets.controller';
import { WagerTransactionsController } from './application/controllers/wager-transactions.controller';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction.use-case';
import { HealthController } from './health/health.controller';
import config from './mikro-orm.config';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController, WalletsController, WagerTransactionsController],
  providers: [CreateWalletUseCase, SubmitWagerTransactionUseCase],
})
export class AppModule {}
