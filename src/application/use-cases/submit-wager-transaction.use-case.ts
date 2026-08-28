import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { Money } from '../../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { InsufficientFundsError } from '../../domain/errors';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import { WagerTransactionEntity, WagerTransactionKindEntity, WagerTransactionStatusEntity } from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { WalletLedgerEntryEntity, WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';

export interface SubmitWagerTransactionInput {
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
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
  idempotencyKey: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  amount: { amount: string; currency: string };
  failureCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: SubmitWagerTransactionInput): Promise<SubmitWagerTransactionOutput> {
    const currency = (input.currency ?? 'BRL').trim().toUpperCase();
    const amount = Money.from({ amount: input.amount, currency });
    const idempotencyKey = input.idempotencyKey ?? `${input.providerId}:${input.externalTransactionId}`;
    const payloadHash = this.buildPayloadHash(input, amount);

    return this.orm.em.transactional(async (em) => {
      const existing = await em.findOne(WagerTransactionEntity, { idempotencyKey });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new ConflictException('Idempotency key already used with a different payload');
        }

        return this.toOutput(existing);
      }

      const wallet = await em.findOne(WalletEntity, { id: input.walletId });
      if (!wallet) {
        throw new NotFoundException(`Wallet ${input.walletId} not found`);
      }

      if (wallet.playerId !== input.playerId) {
        throw new BadRequestException('Wallet does not belong to the provided player');
      }

      const transactionId = randomUUID();
      const tx = WagerTransaction.create({
        id: transactionId,
        walletId: input.walletId,
        playerId: input.playerId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
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

      try {
        if (input.kind === WagerTransactionKind.BET || input.kind === WagerTransactionKind.LOSS) {
          wallet.balanceAmount = (Number(wallet.balanceAmount) - Number(amount.toString())).toFixed(2);
          ledgerType = WalletLedgerEntryType.DEBIT;
        } else if (input.kind === WagerTransactionKind.WIN) {
          wallet.balanceAmount = (Number(wallet.balanceAmount) + Number(amount.toString())).toFixed(2);
          ledgerType = WalletLedgerEntryType.CREDIT;
        }

        if (Number(wallet.balanceAmount) < 0) {
          throw new InsufficientFundsError();
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
        tx.markProcessed();
      }

      wallet.version += 1;
      wallet.updatedAt = new Date();

      const entity = em.create(WagerTransactionEntity, {
        id: tx.id,
        wallet: wallet,
        playerId: tx.playerId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        kind: this.toEntityKind(tx.kind),
        amount: tx.amount.toString(),
        currency: tx.currency,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        status: this.toEntityStatus(tx.status),
        payloadHash: tx.payloadHash,
        failureCode: tx.failureCode,
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
      });

      em.persist(entity);

      if (ledgerType) {
        const balanceBefore = Number(wallet.balanceAmount) - Number(amount.toString());
        const balanceAfter = Number(wallet.balanceAmount);

        const ledgerEntry = em.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          wallet: wallet,
          transaction: entity,
          entryType: ledgerType,
          amount: amount.toString(),
          balanceBefore: balanceBefore.toFixed(2),
          balanceAfter: balanceAfter.toFixed(2),
          createdAt: new Date(),
        });

        em.persist(ledgerEntry);
      }

      return this.toOutput(entity);
    });
  }

  private buildPayloadHash(input: SubmitWagerTransactionInput, amount: Money): string {
    const payload = {
      walletId: input.walletId,
      playerId: input.playerId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
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
      default:
        throw new BadRequestException(`Unsupported wager kind: ${String(kind)}`);
    }
  }

  private toEntityStatus(status: WagerTransactionStatus): WagerTransactionStatusEntity {
    switch (status) {
      case WagerTransactionStatus.PENDING:
        return WagerTransactionStatusEntity.PENDING;
      case WagerTransactionStatus.PROCESSED:
        return WagerTransactionStatusEntity.PROCESSED;
      case WagerTransactionStatus.REJECTED:
        return WagerTransactionStatusEntity.REJECTED;
      default:
        throw new BadRequestException(`Unsupported wager status: ${String(status)}`);
    }
  }

  private toOutput(entity: WagerTransactionEntity): SubmitWagerTransactionOutput {
    return {
      id: entity.id,
      walletId: entity.wallet.id,
      playerId: entity.playerId,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      kind: this.fromEntityKind(entity.kind),
      status: this.fromEntityStatus(entity.status),
      amount: { amount: entity.amount, currency: entity.currency },
      failureCode: entity.failureCode,
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
      default:
        throw new BadRequestException(`Unsupported persisted kind: ${String(kind)}`);
    }
  }

  private fromEntityStatus(status: WagerTransactionStatusEntity): WagerTransactionStatus {
    switch (status) {
      case WagerTransactionStatusEntity.PENDING:
        return WagerTransactionStatus.PENDING;
      case WagerTransactionStatusEntity.PROCESSED:
        return WagerTransactionStatus.PROCESSED;
      case WagerTransactionStatusEntity.REJECTED:
        return WagerTransactionStatus.REJECTED;
      default:
        throw new BadRequestException(`Unsupported persisted status: ${String(status)}`);
    }
  }
}
