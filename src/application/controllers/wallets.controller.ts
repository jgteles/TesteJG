import { Body, Controller, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../use-cases/create-wallet.use-case';
import { CreateWalletDto } from '../dtos/create-wallet.dto';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWalletUseCase: CreateWalletUseCase) {}

  @Post()
  async create(@Body() body: CreateWalletDto) {
    return this.createWalletUseCase.execute(body);
  }
}
