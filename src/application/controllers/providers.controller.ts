import { Controller, Get, Param } from '@nestjs/common';
import { QueryWagerTransactionsUseCase } from '../use-cases/query-wager-transactions.use-case';

@Controller('providers')
export class ProvidersController {
  constructor(private readonly queryWagerTransactionsUseCase: QueryWagerTransactionsUseCase) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async getByProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queryWagerTransactionsUseCase.getByProviderExternalId(providerId, externalTransactionId);
  }
}
