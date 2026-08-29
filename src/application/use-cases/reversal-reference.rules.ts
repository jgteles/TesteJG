import type { EntityManager } from '@mikro-orm/core';
import {
  WagerTransactionEntity,
  WagerTransactionKindEntity,
  WagerTransactionStatusEntity,
} from '../../infrastructure/persistence/mikro-orm/wager-transaction.entity';
import { WalletLedgerEntryType } from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';

export interface ReversalContext {
  walletId: string;
  playerId: string;
  currency: string;
  roundId: string;
  amount: string;
  kind: WagerTransactionKindEntity.REFUND | WagerTransactionKindEntity.ROLLBACK;
}

export async function validateReversalReference(
  em: EntityManager,
  transaction: ReversalContext,
  reference: WagerTransactionEntity,
): Promise<string | undefined> {
  if (reference.status !== WagerTransactionStatusEntity.PROCESSED) return 'REFERENCE_NOT_PROCESSED';
  if (
    reference.wallet.id !== transaction.walletId
    || reference.playerId !== transaction.playerId
    || reference.currency !== transaction.currency
    || reference.roundId !== transaction.roundId
  ) return 'REFERENCE_CONTEXT_MISMATCH';
  if (reference.amount !== transaction.amount) return 'REFERENCE_AMOUNT_MISMATCH';

  const allowed = transaction.kind === WagerTransactionKindEntity.REFUND
    ? reference.kind === WagerTransactionKindEntity.BET
    : [
        WagerTransactionKindEntity.BET,
        WagerTransactionKindEntity.WIN,
        WagerTransactionKindEntity.REFUND,
      ].includes(reference.kind);
  if (!allowed) return 'REFERENCE_TYPE_MISMATCH';

  const previous = await em.findOne(WagerTransactionEntity, {
    referenceTransactionId: reference.id,
    kind: transaction.kind,
    status: WagerTransactionStatusEntity.PROCESSED,
  });
  return previous ? 'REFERENCE_ALREADY_REVERSED' : undefined;
}

export function reversalLedgerType(
  transactionKind: WagerTransactionKindEntity.REFUND | WagerTransactionKindEntity.ROLLBACK,
  referenceKind: WagerTransactionKindEntity,
): WalletLedgerEntryType {
  return transactionKind === WagerTransactionKindEntity.REFUND
    || referenceKind === WagerTransactionKindEntity.BET
    ? WalletLedgerEntryType.CREDIT
    : WalletLedgerEntryType.DEBIT;
}
