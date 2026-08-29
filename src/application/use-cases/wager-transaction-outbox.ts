import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/core';
import {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/integration-event';
import { OutboxMessageEntity } from '../../infrastructure/persistence/mikro-orm/outbox-message.entity';
import { WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import { WagerTransactionEntity, WagerTransactionStatusEntity } from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';

export interface BalanceChangeEventData {
  direction: WalletLedgerEntryType;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
}

export function enqueueWagerTransactionEvents(
  em: EntityManager,
  transaction: WagerTransactionEntity,
  balanceChange?: BalanceChangeEventData,
): void {
  const occurredAt = new Date();
  const props = {
    eventId: randomUUID(),
    aggregateId: transaction.id,
    correlationId: transaction.idempotencyKey,
    occurredAt,
  };
  const commonData = {
    transactionId: transaction.id,
    walletId: transaction.wallet.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
    money: { amount: transaction.amount, currency: transaction.currency },
    balance: { amount: transaction.balanceAfter, currency: transaction.currency },
  };
  const events: IntegrationEvent<Record<string, unknown>>[] = [];

  if (transaction.status === WagerTransactionStatusEntity.PROCESSED) {
    events.push(new WagerTransactionProcessed({ ...props, data: commonData }));
  } else if (transaction.status === WagerTransactionStatusEntity.REJECTED) {
    events.push(new WagerTransactionRejected({
      ...props,
      data: { ...commonData, failureCode: transaction.failureCode },
    }));
  } else if (transaction.status === WagerTransactionStatusEntity.PENDING_REFERENCE) {
    events.push(new WagerTransactionPendingReference({
      ...props,
      data: {
        ...commonData,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    }));
  }

  if (balanceChange) {
    events.push(new WalletBalanceChanged({
      ...props,
      eventId: randomUUID(),
      data: {
        walletId: transaction.wallet.id,
        transactionId: transaction.id,
        direction: balanceChange.direction,
        money: { amount: balanceChange.amount, currency: transaction.currency },
        balanceBefore: { amount: balanceChange.balanceBefore, currency: transaction.currency },
        balanceAfter: { amount: balanceChange.balanceAfter, currency: transaction.currency },
        walletVersion: balanceChange.walletVersion,
      },
    }));
  }

  for (const event of events) {
    em.persist(em.create(OutboxMessageEntity, {
      id: event.eventId,
      eventType: event.eventType,
      aggregateType: 'WagerTransaction',
      aggregateId: event.aggregateId,
      payload: event.toJSON(),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }));
  }
}
