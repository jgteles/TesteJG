import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from '../use-cases/submit-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { SubmitWagerTransactionDto } from '../dtos/submit-wager-transaction.dto';
import { QueryWagerTransactionsUseCase } from '../use-cases/query-wager-transactions.use-case';

interface SubmitWagerTransactionHttpResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

@Controller('wagering')
export class WagerTransactionsController {
  constructor(
    private readonly submitWagerTransactionUseCase: SubmitWagerTransactionUseCase,
    private readonly queryWagerTransactionsUseCase: QueryWagerTransactionsUseCase,
  ) {}

  @Get('transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return this.queryWagerTransactionsUseCase.getById(transactionId);
  }

  @Post('transactions')
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) httpResponse: { status(code: number): unknown },
  ): Promise<SubmitWagerTransactionHttpResponse> {
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
      referenceExternalTransactionId: body.referenceExternalTransactionId,
    });

    const response = this.toHttpResponse(result);

    if (response.status === WagerTransactionStatus.REJECTED) {
      throw new UnprocessableEntityException(response);
    }

    if (response.status === WagerTransactionStatus.PENDING_REFERENCE) {
      httpResponse.status(HttpStatus.ACCEPTED);
    }

    return response;
  }

  private toHttpResponse(result: Awaited<ReturnType<SubmitWagerTransactionUseCase['execute']>>): SubmitWagerTransactionHttpResponse {
    return {
      transactionId: result.id,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }
}
