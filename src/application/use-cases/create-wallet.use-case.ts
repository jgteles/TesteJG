import { MikroORM } from '@mikro-orm/core';
import { randomUUID, createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WagerTransactionEntity, WagerTransactionKindEntity, WagerTransactionStatusEntity } from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';

export interface CreateWalletInput {
  playerId: string;
  currency?: string;
  initialBalance?: {
    amount: string;
    currency?: string;
  };
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  currency: string;
  balance: { amount: string; currency: string };
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const currency = (input.currency ?? 'BRL').trim().toUpperCase();
    const initialBalanceAmount = input.initialBalance ?? { amount: '0.00', currency };

    const initialBalance = Money.from({
      amount: initialBalanceAmount.amount,
      currency: initialBalanceAmount.currency ?? currency,
    });

    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
    });

    await this.orm.em.transactional(async (em) => {
      const walletEntity = em.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceAmount: wallet.balance.toString(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });

      em.persist(walletEntity);

      if (initialBalance.isPositive()) {
        const openingIdempotencyKey = `wallet-open:${wallet.id}`;
        const openingPayload = {
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: WagerTransactionKindEntity.OPENING,
          amount: initialBalance.toJSON(),
          currency: wallet.currency,
          referenceExternalTransactionId: null,
        };

        const openingHash = createHash('sha256')
          .update(JSON.stringify(openingPayload, Object.keys(openingPayload).sort()))
          .digest('hex');

        const openingTransaction = em.create(WagerTransactionEntity, {
          id: randomUUID(),
          wallet: walletEntity,
          playerId: wallet.playerId,
          providerId: 'system',
          externalTransactionId: `wallet-open:${wallet.id}`,
          idempotencyKey: openingIdempotencyKey,
          kind: WagerTransactionKindEntity.OPENING,
          amount: initialBalance.toString(),
          currency: wallet.currency,
          referenceExternalTransactionId: null,
          status: WagerTransactionStatusEntity.PROCESSED,
          payloadHash: openingHash,
          balanceAfter: initialBalance.toString(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        em.persist(openingTransaction);

        const ledgerEntry = em.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          wallet: walletEntity,
          transaction: openingTransaction,
          entryType: WalletLedgerEntryType.CREDIT,
          amount: initialBalance.toString(),
          balanceBefore: '0.00',
          balanceAfter: initialBalance.toString(),
          createdAt: new Date(),
        });

        em.persist(ledgerEntry);
      }
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}
