import { BadRequestException, Body, Controller, Headers, Post, UnprocessableEntityException } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from '../use-cases/submit-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { SubmitWagerTransactionDto } from '../dtos/submit-wager-transaction.dto';

@Controller('wagering')
export class WagerTransactionsController {
  constructor(private readonly submitWagerTransactionUseCase: SubmitWagerTransactionUseCase) {}

  @Post('transactions')
  async create(@Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: SubmitWagerTransactionDto) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.submitWagerTransactionUseCase.execute({
      walletId: body.walletId,
      playerId: body.playerId,
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      amount: body.money.amount,
      currency: body.money.currency,
      idempotencyKey,
    });

    if (result.status === WagerTransactionStatus.REJECTED) {
      throw new UnprocessableEntityException(result);
    }

    return result;
  }
}
