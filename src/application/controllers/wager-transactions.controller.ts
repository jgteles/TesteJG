import { Body, Controller, Post } from '@nestjs/common';
import { SubmitWagerTransactionUseCase, SubmitWagerTransactionInput } from '../use-cases/submit-wager-transaction.use-case';

@Controller('wager-transactions')
export class WagerTransactionsController {
  constructor(private readonly submitWagerTransactionUseCase: SubmitWagerTransactionUseCase) {}

  @Post()
  async create(@Body() body: SubmitWagerTransactionInput) {
    return this.submitWagerTransactionUseCase.execute(body);
  }
}
