import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';
import { SubmitWagerTransactionUseCase, SubmitWagerTransactionInput } from '../use-cases/submit-wager-transaction.use-case';

@Controller('wagering')
export class WagerTransactionsController {
  constructor(private readonly submitWagerTransactionUseCase: SubmitWagerTransactionUseCase) {}

  @Post('transactions')
  async create(@Headers() headers: Record<string, string | string[] | undefined>, @Body() body: SubmitWagerTransactionInput) {
    const idempotencyKey =
      (headers['idempotency-key'] as string | undefined) ??
      (headers['Idempotency-Key'] as string | undefined) ??
      (headers['IDEMPOTENCY-KEY'] as string | undefined);

    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    return this.submitWagerTransactionUseCase.execute({
      ...body,
      idempotencyKey,
    });
  }
}
