import { Injectable, NotFoundException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { WagerTransactionEntity } from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';

@Injectable()
export class QueryWagerTransactionsUseCase {
  constructor(private readonly orm: MikroORM) {}

  async getById(transactionId: string) {
    const transaction = await this.orm.em.findOne(WagerTransactionEntity, { id: transactionId }, { populate: ['wallet'] });
    return this.toResponse(transaction);
  }

  async getByProviderExternalId(providerId: string, externalTransactionId: string) {
    const transaction = await this.orm.em.findOne(
      WagerTransactionEntity,
      { providerId, externalTransactionId },
      { populate: ['wallet'] },
    );
    return this.toResponse(transaction);
  }

  private toResponse(transaction: WagerTransactionEntity | null) {
    if (!transaction) {
      throw new NotFoundException('Wager transaction not found');
    }

    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.wallet.id,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: { amount: transaction.amount, currency: transaction.currency },
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      processedAt: transaction.processedAt,
      balance: { amount: transaction.balanceAfter, currency: transaction.currency },
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    };
  }
}
