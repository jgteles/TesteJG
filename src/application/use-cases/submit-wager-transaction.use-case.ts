import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException, Optional } from '@nestjs/common';
import { LockMode, MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { InsufficientFundsError } from '../../domain/errors';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WagerTransactionEntity, WagerTransactionKindEntity, WagerTransactionStatusEntity } from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { reversalLedgerType, validateReversalReference } from './reversal-reference.rules';
import { enqueueWagerTransactionEvents } from './wager-transaction-outbox';
import { OperationalMetricsService } from '../../observability/operational-metrics.service';

export interface SubmitWagerTransactionInput {
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  idempotencyKey?: string;
  kind: WagerTransactionKind;
  amount: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionOutput {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  idempotencyKey: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  amount: { amount: string; currency: string };
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
  referenceTransactionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SubmitWagerTransactionUseCase {
  private readonly logger = new Logger(SubmitWagerTransactionUseCase.name);

  constructor(
    private readonly orm: MikroORM,
    @Optional() private readonly metrics?: OperationalMetricsService,
  ) {}

  async execute(input: SubmitWagerTransactionInput): Promise<SubmitWagerTransactionOutput> {
    const startedAt = Date.now();
    try {
      const result = await this.orm.em.transactional((em) => this.executeInTransaction(em, input));
      this.metrics?.transaction(result.status, result.idempotentReplay, Date.now() - startedAt);
      this.logger.log({
        event: 'wager_transaction_completed',
        correlationId: result.idempotencyKey,
        transactionId: result.id,
        walletId: result.walletId,
        providerId: result.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } catch (error) {
      if (this.isLockConflict(error)) this.metrics?.lockConflict();
      throw error;
    }
  }

  async executeInTransaction(
    em: EntityManager,
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionOutput> {
    const currency = (input.currency ?? 'BRL').trim().toUpperCase();
    const amount = Money.from({ amount: input.amount, currency });
    if (!amount.isPositive()) {
      throw new BadRequestException('Amount must be greater than zero');
    }
    const idempotencyKey = input.idempotencyKey ?? `${input.providerId}:${input.externalTransactionId}`;
    const payloadHash = this.buildPayloadHash(input, amount);

    const sqlEm = em as unknown as PostgreSqlEntityManager;

      // Claim the key before checking the transaction. A concurrent delivery
      // blocks on this row and resumes only after the first one commits.
      await sqlEm.execute(
        'insert into idempotency_keys (key) values (?) on conflict do nothing',
        [idempotencyKey],
      );
      await sqlEm.execute(
        'select key from idempotency_keys where key = ? for update',
        [idempotencyKey],
      );

      const existing = await em.findOne(WagerTransactionEntity, { idempotencyKey });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new ConflictException('Idempotency key already used with a different payload');
        }

        return this.toOutput(existing, true);
      }

      const walletEntity = await em.findOne(
        WalletEntity,
        { id: input.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletEntity) {
        throw new NotFoundException(`Wallet ${input.walletId} not found`);
      }

      if (walletEntity.playerId !== input.playerId) {
        throw new BadRequestException('Wallet does not belong to the provided player');
      }

      const wallet = Wallet.rehydrate({
        id: walletEntity.id,
        playerId: walletEntity.playerId,
        currency: walletEntity.currency,
        balance: Money.from({ amount: walletEntity.balanceAmount, currency: walletEntity.currency }),
        version: walletEntity.version,
        createdAt: walletEntity.createdAt,
        updatedAt: walletEntity.updatedAt,
      });

      const transactionId = randomUUID();
      const tx = WagerTransaction.create({
        id: transactionId,
        walletId: input.walletId,
        playerId: input.playerId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        roundId: input.roundId,
        gameId: input.gameId,
        idempotencyKey,
        payloadHash,
        kind: input.kind,
        amount,
        currency: amount.currency,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      });

      let status = WagerTransactionStatus.PROCESSED;
      let failureCode: string | undefined;
      let ledgerType: WalletLedgerEntryType | undefined;
      let balanceBefore: Money | undefined;
      let balanceAfter: Money | undefined;
      let referenceEntity: WagerTransactionEntity | null = null;

      try {
        if (input.kind === WagerTransactionKind.BET) {
          balanceBefore = wallet.balance;
          wallet.debit(amount);
          balanceAfter = wallet.balance;
          ledgerType = WalletLedgerEntryType.DEBIT;
        } else if (input.kind === WagerTransactionKind.WIN) {
          balanceBefore = wallet.balance;
          wallet.credit(amount);
          balanceAfter = wallet.balance;
          ledgerType = WalletLedgerEntryType.CREDIT;
        } else if (input.kind === WagerTransactionKind.LOSS) {
          // No balance mutation and no ledger entry: LOSS only records the outcome.
        } else if (tx.requiresReference()) {
          referenceEntity = await em.findOne(WagerTransactionEntity, {
            providerId: input.providerId,
            externalTransactionId: input.referenceExternalTransactionId!,
          });

          if (!referenceEntity) {
            status = WagerTransactionStatus.PENDING_REFERENCE;
            tx.markPendingReference();
          } else {
            const reversalKind = this.toEntityKind(tx.kind) as
              | WagerTransactionKindEntity.REFUND
              | WagerTransactionKindEntity.ROLLBACK;
            failureCode = await validateReversalReference(em, {
              walletId: tx.walletId,
              playerId: tx.playerId,
              currency: tx.currency,
              roundId: tx.roundId,
              amount: tx.amount.toString(),
              kind: reversalKind,
            }, referenceEntity);
            if (failureCode) {
              status = WagerTransactionStatus.REJECTED;
              tx.markRejected(failureCode);
            } else {
              balanceBefore = wallet.balance;
              ledgerType = reversalLedgerType(reversalKind, referenceEntity.kind);
              if (ledgerType === WalletLedgerEntryType.CREDIT) {
                wallet.credit(amount);
              } else {
                try {
                  wallet.debit(amount);
                } catch (error) {
                  if (!(error instanceof InsufficientFundsError)) throw error;
                  status = WagerTransactionStatus.REJECTED;
                  failureCode = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE';
                  tx.markRejected(failureCode);
                }
              }
              if (status === WagerTransactionStatus.PROCESSED) balanceAfter = wallet.balance;
            }
          }
        } else {
          throw new BadRequestException(`Unsupported wager kind: ${String(input.kind)}`);
        }
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          status = WagerTransactionStatus.REJECTED;
          failureCode = 'INSUFFICIENT_FUNDS';
          tx.markRejected(failureCode);
        } else {
          throw error;
        }
      }

      if (status === WagerTransactionStatus.PROCESSED) {
        tx.markProcessed(referenceEntity?.id);
      }

      walletEntity.balanceAmount = wallet.balance.toString();
      walletEntity.version = wallet.version;
      walletEntity.updatedAt = wallet.updatedAt;

      const entity = em.create(WagerTransactionEntity, {
        id: tx.id,
        wallet: walletEntity,
        playerId: tx.playerId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        idempotencyKey: tx.idempotencyKey,
        kind: this.toEntityKind(tx.kind),
        amount: tx.amount.toString(),
        currency: tx.currency,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        referenceTransactionId: tx.referenceTransactionId,
        status: this.toEntityStatus(tx.status),
        payloadHash: tx.payloadHash,
        failureCode: tx.failureCode,
        balanceAfter: wallet.balance.toString(),
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
      });

      em.persist(entity);

      if (ledgerType && balanceBefore && balanceAfter) {
        const domainLedgerEntry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: tx.id,
          type: ledgerType,
          amount,
          balanceBefore,
          balanceAfter,
        });

        const ledgerEntry = em.create(WalletLedgerEntryEntity, {
          id: domainLedgerEntry.id,
          wallet: walletEntity,
          transaction: entity,
          entryType: ledgerType,
          amount: domainLedgerEntry.amount.toString(),
          balanceBefore: domainLedgerEntry.balanceBefore.toString(),
          balanceAfter: domainLedgerEntry.balanceAfter.toString(),
          createdAt: domainLedgerEntry.createdAt,
        });

        em.persist(ledgerEntry);
      }

      enqueueWagerTransactionEvents(
        em,
        entity,
        ledgerType && balanceBefore && balanceAfter
          ? {
              direction: ledgerType,
              amount: amount.toString(),
              balanceBefore: balanceBefore.toString(),
              balanceAfter: balanceAfter.toString(),
              walletVersion: wallet.version,
            }
          : undefined,
      );

    return this.toOutput(entity, false, wallet.balance);
  }

  private buildPayloadHash(input: SubmitWagerTransactionInput, amount: Money): string {
    const payload = {
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      amount: amount.toJSON(),
      currency: amount.currency,
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    };

    return createHash('sha256').update(JSON.stringify(payload, Object.keys(payload).sort())).digest('hex');
  }

  private toEntityKind(kind: WagerTransactionKind): WagerTransactionKindEntity {
    switch (kind) {
      case WagerTransactionKind.BET:
        return WagerTransactionKindEntity.BET;
      case WagerTransactionKind.WIN:
        return WagerTransactionKindEntity.WIN;
      case WagerTransactionKind.LOSS:
        return WagerTransactionKindEntity.LOSS;
      case WagerTransactionKind.REFUND:
        return WagerTransactionKindEntity.REFUND;
      case WagerTransactionKind.ROLLBACK:
        return WagerTransactionKindEntity.ROLLBACK;
      default:
        throw new BadRequestException(`Unsupported wager kind: ${String(kind)}`);
    }
  }

  private toEntityStatus(status: WagerTransactionStatus): WagerTransactionStatusEntity {
    switch (status) {
      case WagerTransactionStatus.PENDING:
        return WagerTransactionStatusEntity.PENDING;
      case WagerTransactionStatus.PENDING_REFERENCE:
        return WagerTransactionStatusEntity.PENDING_REFERENCE;
      case WagerTransactionStatus.PROCESSED:
        return WagerTransactionStatusEntity.PROCESSED;
      case WagerTransactionStatus.REJECTED:
        return WagerTransactionStatusEntity.REJECTED;
      default:
        throw new BadRequestException(`Unsupported wager status: ${String(status)}`);
    }
  }

  private toOutput(
    entity: WagerTransactionEntity,
    idempotentReplay: boolean,
    currentBalance?: Money,
  ): SubmitWagerTransactionOutput {
    const balance = currentBalance ?? Money.from({
      amount: entity.balanceAfter,
      currency: entity.currency,
    });

    return {
      id: entity.id,
      walletId: entity.wallet.id,
      playerId: entity.playerId,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      roundId: entity.roundId!,
      gameId: entity.gameId!,
      idempotencyKey: entity.idempotencyKey,
      kind: this.fromEntityKind(entity.kind),
      status: this.fromEntityStatus(entity.status),
      amount: { amount: entity.amount, currency: entity.currency },
      balance: balance.toJSON(),
      idempotentReplay,
      failureCode: entity.failureCode,
      referenceTransactionId: entity.referenceTransactionId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  private fromEntityKind(kind: WagerTransactionKindEntity): WagerTransactionKind {
    switch (kind) {
      case WagerTransactionKindEntity.BET:
        return WagerTransactionKind.BET;
      case WagerTransactionKindEntity.WIN:
        return WagerTransactionKind.WIN;
      case WagerTransactionKindEntity.LOSS:
        return WagerTransactionKind.LOSS;
      case WagerTransactionKindEntity.REFUND:
        return WagerTransactionKind.REFUND;
      case WagerTransactionKindEntity.ROLLBACK:
        return WagerTransactionKind.ROLLBACK;
      default:
        throw new BadRequestException(`Unsupported persisted kind: ${String(kind)}`);
    }
  }

  private fromEntityStatus(status: WagerTransactionStatusEntity): WagerTransactionStatus {
    switch (status) {
      case WagerTransactionStatusEntity.PENDING:
        return WagerTransactionStatus.PENDING;
      case WagerTransactionStatusEntity.PENDING_REFERENCE:
        return WagerTransactionStatus.PENDING_REFERENCE;
      case WagerTransactionStatusEntity.PROCESSED:
        return WagerTransactionStatus.PROCESSED;
      case WagerTransactionStatusEntity.REJECTED:
        return WagerTransactionStatus.REJECTED;
      default:
        throw new BadRequestException(`Unsupported persisted status: ${String(status)}`);
    }
  }

  private isLockConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    return ['40P01', '40001', '55P03'].includes(String(error.code));
  }

}
