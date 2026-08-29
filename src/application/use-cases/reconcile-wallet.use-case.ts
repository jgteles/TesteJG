import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { Money, MoneyProps } from '../../domain/money';
import { LedgerBalanceMismatchError } from '../../domain/errors';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';
import {
  WalletLedgerEntryEntity,
  WalletLedgerEntryType,
} from '../../infrastructure/persistence/mikro-orm/wallet-ledger-entry.entity';
import { OperationalMetricsService } from '../../observability/operational-metrics.service';

export interface ReconcileWalletOutput {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    private readonly orm: MikroORM,
    @Optional() private readonly metrics?: OperationalMetricsService,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletOutput> {
    const em = this.orm.em.fork();
    const wallet = await em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const entries = await em.find(
      WalletLedgerEntryEntity,
      { wallet: { id: walletId } },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    const storedBalance = Money.from({
      amount: wallet.balanceAmount,
      currency: wallet.currency,
    });
    let calculatedBalance = Money.zero(wallet.currency);

    for (const entry of entries) {
      const amount = Money.from({ amount: entry.amount, currency: wallet.currency });
      const balanceBefore = Money.from({ amount: entry.balanceBefore, currency: wallet.currency });
      const balanceAfter = Money.from({ amount: entry.balanceAfter, currency: wallet.currency });
      const type = entry.entryType === WalletLedgerEntryType.DEBIT ? 'DEBIT' : 'CREDIT';
      const ledgerEntry = WalletLedgerEntry.create({
        id: entry.id,
        walletId,
        transactionId: entry.transaction.id,
        type,
        amount,
        balanceBefore,
        balanceAfter,
        createdAt: entry.createdAt,
      });

      if (!calculatedBalance.equals(ledgerEntry.balanceBefore)) {
        throw new LedgerBalanceMismatchError();
      }

      calculatedBalance = type === 'DEBIT'
        ? calculatedBalance.subtract(ledgerEntry.amount)
        : calculatedBalance.add(ledgerEntry.amount);

      if (!calculatedBalance.equals(ledgerEntry.balanceAfter)) {
        throw new LedgerBalanceMismatchError();
      }
    }

    const consistent = storedBalance.equals(calculatedBalance);
    if (!consistent) {
      this.metrics?.reconciliationDivergence();
      this.logger.warn({ event: 'wallet_reconciliation_divergence', walletId });
    }

    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: calculatedBalance.subtract(storedBalance).toJSON(),
      consistent,
      checkedEntries: entries.length,
    };
  }
}
