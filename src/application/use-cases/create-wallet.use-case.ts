import { MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WalletEntity } from '../../infrastructure/persistence/mikro-orm/wallet.entity';

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
      const entity = em.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceAmount: wallet.balance.toString(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });

      em.persist(entity);
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
