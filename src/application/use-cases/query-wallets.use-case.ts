import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';

interface LedgerCursor {
  createdAt: string;
  id: string;
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  entry_type: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

@Injectable()
export class QueryWalletsUseCase {
  constructor(private readonly orm: MikroORM) {}

  async getWallet(walletId: string) {
    const wallet = await this.orm.em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balanceAmount, currency: wallet.currency },
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  async getLedger(walletId: string, cursor?: string, requestedLimit?: string) {
    const wallet = await this.orm.em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const limit = this.parseLimit(requestedLimit);
    const position = cursor ? this.decodeCursor(cursor) : undefined;
    const parameters: unknown[] = [walletId];
    let afterCursor = '';

    if (position) {
      afterCursor = 'AND (created_at, id) > (?, ?)';
      parameters.push(position.createdAt, position.id);
    }

    parameters.push(limit + 1);

    const rows = await this.orm.em.getConnection().execute<LedgerRow[]>(
      `SELECT id, wallet_id, transaction_id, entry_type, amount,
              balance_before, balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ?
          ${afterCursor}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
      parameters,
    );

    const hasNextPage = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      entries: page.map((entry) => ({
        id: entry.id,
        walletId: entry.wallet_id,
        transactionId: entry.transaction_id,
        direction: entry.entry_type,
        money: { amount: entry.amount, currency: wallet.currency },
        balanceBefore: { amount: entry.balance_before, currency: wallet.currency },
        balanceAfter: { amount: entry.balance_after, currency: wallet.currency },
        createdAt: new Date(entry.created_at),
      })),
      nextCursor: hasNextPage && last
        ? this.encodeCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id })
        : null,
    };
  }

  private parseLimit(value?: string): number {
    if (value === undefined) {
      return 50;
    }

    if (!/^\d+$/.test(value) || Number(value) < 1) {
      throw new BadRequestException('Ledger limit must be a positive integer');
    }

    return Number(value);
  }

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private decodeCursor(cursor: string): LedgerCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<LedgerCursor>;
      const createdAt = new Date(parsed.createdAt ?? '');

      if (!parsed.id || Number.isNaN(createdAt.getTime())) {
        throw new Error('Invalid cursor');
      }

      return { createdAt: createdAt.toISOString(), id: parsed.id };
    } catch {
      throw new BadRequestException('Invalid ledger cursor');
    }
  }
}
