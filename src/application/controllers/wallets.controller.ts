import { Body, Controller, Param, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../use-cases/create-wallet.use-case';
import { CreateWalletDto } from '../dtos/create-wallet.dto';
import { ReconcileWalletUseCase } from '../use-cases/reconcile-wallet.use-case';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletDto) {
    return this.createWalletUseCase.execute(body);
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}
