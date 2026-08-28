import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WalletsController } from './application/controllers/wallets.controller';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { HealthController } from './health/health.controller';
import config from './mikro-orm.config';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController, WalletsController],
  providers: [CreateWalletUseCase],
})
export class AppModule {}
