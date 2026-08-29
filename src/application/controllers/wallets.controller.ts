import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CreateWalletUseCase } from '../use-cases/create-wallet.use-case';
import { CreateWalletDto } from '../dtos/create-wallet.dto';
import { ReconcileWalletUseCase } from '../use-cases/reconcile-wallet.use-case';
import { QueryWalletsUseCase } from '../use-cases/query-wallets.use-case';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    private readonly queryWalletsUseCase: QueryWalletsUseCase,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletDto) {
    return this.createWalletUseCase.execute(body);
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    return this.queryWalletsUseCase.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.queryWalletsUseCase.getLedger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}
