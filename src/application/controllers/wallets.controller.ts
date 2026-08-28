import { Body, Controller, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../use-cases/create-wallet.use-case';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWalletUseCase: CreateWalletUseCase) {}

  @Post()
  async create(@Body() body: { playerId: string; currency?: string; initialBalance?: { amount: string; currency?: string } }) {
    return this.createWalletUseCase.execute(body);
  }
}
