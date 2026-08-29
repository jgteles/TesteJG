import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { LockMode, MikroORM } from '@mikro-orm/core';
import { InsufficientFundsError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import {
  WagerTransactionEntity,
  WagerTransactionKindEntity,
  WagerTransactionStatusEntity,
} from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { reversalLedgerType, validateReversalReference } from './reversal-reference.rules';
import { enqueueWagerTransactionEvents } from './wager-transaction-outbox';

export interface ReprocessPendingReferenceOutput {
  id: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  referenceTransactionId?: string;
  failureCode?: string;
  reprocessed: boolean;
}

@Injectable()
export class ReprocessPendingReferenceUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(transactionId: string): Promise<ReprocessPendingReferenceOutput> {
    return this.orm.em.transactional(async (em) => {
      const entity = await em.findOne(
        WagerTransactionEntity,
        { id: transactionId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!entity) throw new NotFoundException(`Wager transaction ${transactionId} not found`);

      if (entity.status !== WagerTransactionStatusEntity.PENDING_REFERENCE) {
        return this.toOutput(entity, false);
      }

      const reference = await em.findOne(WagerTransactionEntity, {
        providerId: entity.providerId,
        externalTransactionId: entity.referenceExternalTransactionId!,
      });
      if (!reference) return this.toOutput(entity, false);

      const walletEntity = await em.findOne(
        WalletEntity,
        { id: entity.wallet.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!walletEntity) throw new NotFoundException(`Wallet ${entity.wallet.id} not found`);

      const amount = Money.from({ amount: entity.amount, currency: entity.currency });
      const wallet = Wallet.rehydrate({
        id: walletEntity.id,
        playerId: walletEntity.playerId,
        currency: walletEntity.currency,
        balance: Money.from({ amount: walletEntity.balanceAmount, currency: walletEntity.currency }),
        version: walletEntity.version,
        createdAt: walletEntity.createdAt,
        updatedAt: walletEntity.updatedAt,
      });
      const transaction = this.rehydrateTransaction(entity, amount);
      const reversalKind = entity.kind as
        | WagerTransactionKindEntity.REFUND
        | WagerTransactionKindEntity.ROLLBACK;
      const failureCode = await validateReversalReference(em, {
        walletId: entity.wallet.id,
        playerId: entity.playerId,
        currency: entity.currency,
        roundId: entity.roundId!,
        amount: entity.amount,
        kind: reversalKind,
      }, reference);

      if (failureCode) {
        transaction.markRejected(failureCode);
        this.updateEntity(entity, transaction, wallet.balance);
        enqueueWagerTransactionEvents(em, entity);
        return this.toOutput(entity, true);
      }

      const ledgerType = reversalLedgerType(reversalKind, reference.kind);
      const balanceBefore = wallet.balance;
      try {
        if (ledgerType === WalletLedgerEntryType.CREDIT) wallet.credit(amount);
        else wallet.debit(amount);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        transaction.markRejected('REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE');
        this.updateEntity(entity, transaction, wallet.balance);
        enqueueWagerTransactionEvents(em, entity);
        return this.toOutput(entity, true);
      }

      transaction.markProcessed(reference.id);
      this.updateEntity(entity, transaction, wallet.balance);
      walletEntity.balanceAmount = wallet.balance.toString();
      walletEntity.version = wallet.version;
      walletEntity.updatedAt = wallet.updatedAt;

      const ledger = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: entity.id,
        type: ledgerType,
        amount,
        balanceBefore,
        balanceAfter: wallet.balance,
      });
      em.persist(em.create(WalletLedgerEntryEntity, {
        id: ledger.id,
        wallet: walletEntity,
        transaction: entity,
        entryType: ledgerType,
        amount: ledger.amount.toString(),
        balanceBefore: ledger.balanceBefore.toString(),
        balanceAfter: ledger.balanceAfter.toString(),
        createdAt: ledger.createdAt,
      }));
      enqueueWagerTransactionEvents(em, entity, {
        direction: ledgerType,
        amount: ledger.amount.toString(),
        balanceBefore: ledger.balanceBefore.toString(),
        balanceAfter: ledger.balanceAfter.toString(),
        walletVersion: wallet.version,
      });

      return this.toOutput(entity, true);
    });
  }

  private rehydrateTransaction(entity: WagerTransactionEntity, amount: Money): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      walletId: entity.wallet.id,
      playerId: entity.playerId,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      roundId: entity.roundId!,
      gameId: entity.gameId!,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      kind: entity.kind === WagerTransactionKindEntity.REFUND
        ? WagerTransactionKind.REFUND
        : WagerTransactionKind.ROLLBACK,
      amount,
      currency: entity.currency,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      status: WagerTransactionStatus.PENDING_REFERENCE,
      failureCode: entity.failureCode,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  private updateEntity(entity: WagerTransactionEntity, transaction: WagerTransaction, balance: Money): void {
    entity.status = transaction.status === WagerTransactionStatus.PROCESSED
      ? WagerTransactionStatusEntity.PROCESSED
      : WagerTransactionStatusEntity.REJECTED;
    entity.referenceTransactionId = transaction.referenceTransactionId;
    entity.failureCode = transaction.failureCode;
    entity.balanceAfter = balance.toString();
    entity.updatedAt = transaction.updatedAt;
  }

  private toOutput(entity: WagerTransactionEntity, reprocessed: boolean): ReprocessPendingReferenceOutput {
    return {
      id: entity.id,
      status: this.toDomainStatus(entity.status),
      balance: { amount: entity.balanceAfter, currency: entity.currency },
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: entity.failureCode ?? undefined,
      reprocessed,
    };
  }

  private toDomainStatus(status: WagerTransactionStatusEntity): WagerTransactionStatus {
    switch (status) {
      case WagerTransactionStatusEntity.PENDING:
        return WagerTransactionStatus.PENDING;
      case WagerTransactionStatusEntity.PENDING_REFERENCE:
        return WagerTransactionStatus.PENDING_REFERENCE;
      case WagerTransactionStatusEntity.PROCESSED:
        return WagerTransactionStatus.PROCESSED;
      case WagerTransactionStatusEntity.REJECTED:
        return WagerTransactionStatus.REJECTED;
    }
  }
}
