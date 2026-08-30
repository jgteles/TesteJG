import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from '../../mikro-orm.config';
import { ApplicationExceptionFilter } from '../filters/application-exception.filter';
import { CreateWalletUseCase } from '../use-cases/create-wallet.use-case';
import { QueryWalletsUseCase } from '../use-cases/query-wallets.use-case';
import { QueryWagerTransactionsUseCase } from '../use-cases/query-wager-transactions.use-case';
import { ReconcileWalletUseCase } from '../use-cases/reconcile-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '../use-cases/submit-wager-transaction.use-case';
import { ProvidersController } from './providers.controller';
import { WagerTransactionsController } from './wager-transactions.controller';
import { WalletsController } from './wallets.controller';

describe('Wagering HTTP contract', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MikroOrmModule.forRoot(config)],
      controllers: [WalletsController, WagerTransactionsController, ProvidersController],
      providers: [
        CreateWalletUseCase,
        QueryWalletsUseCase,
        QueryWagerTransactionsUseCase,
        ReconcileWalletUseCase,
        SubmitWagerTransactionUseCase,
      ],
    }).compile();

    await module.get(MikroORM).migrator.up();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }));
    app.useGlobalFilters(new ApplicationExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the documented PROCESSED response and replays the original result', async () => {
    const wallet = await createWallet('100.00');
    const payload = wagerPayload(wallet.id, wallet.playerId, 'BET', '25.00');
    const idempotencyKey = randomUUID();

    const first = await postWager(payload, idempotencyKey);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(firstBody).not.toHaveProperty('id');
    expect(typeof firstBody.balance.amount).toBe('string');

    const replay = await postWager(payload, idempotencyKey);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({
      ...firstBody,
      idempotentReplay: true,
    });
  });

  it('distinguishes missing idempotency key, invalid request, conflict, and missing wallet', async () => {
    const wallet = await createWallet('100.00');
    const payload = wagerPayload(wallet.id, wallet.playerId, 'BET', '25.00');

    expect((await postWager(payload)).status).toBe(400);
    expect((await postWager({ ...payload, money: { amount: '1.234', currency: 'BRL' } }, randomUUID())).status)
      .toBe(400);

    const idempotencyKey = randomUUID();
    expect((await postWager(payload, idempotencyKey)).status).toBe(201);
    expect((await postWager({ ...payload, money: { amount: '26.00', currency: 'BRL' } }, idempotencyKey)).status)
      .toBe(409);

    const missingWalletPayload = wagerPayload(randomUUID(), randomUUID(), 'BET', '25.00');
    expect((await postWager(missingWalletPayload, randomUUID())).status).toBe(404);
  });

  it('returns a machine-readable REJECTED response for insufficient funds', async () => {
    const wallet = await createWallet('10.00');
    const response = await postWager(
      wagerPayload(wallet.id, wallet.playerId, 'BET', '25.00'),
      randomUUID(),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('returns an accepted PENDING_REFERENCE response without changing money representation', async () => {
    const wallet = await createWallet('100.00');
    const payload = {
      ...wagerPayload(wallet.id, wallet.playerId, 'REFUND', '25.00'),
      referenceExternalTransactionId: randomUUID(),
    };
    const response = await postWager(payload, randomUUID());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      transactionId: expect.any(String),
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('serves the mandatory GET endpoints through the Nest HTTP transport', async () => {
    const wallet = await createWallet('100.00');
    const payload = wagerPayload(wallet.id, wallet.playerId, 'BET', '25.00');
    const submitted = await postWager(payload, randomUUID());
    const { transactionId } = await submitted.json();

    const walletResponse = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    expect(walletResponse.status).toBe(200);
    expect((await walletResponse.json()).balance).toEqual({ amount: '75.00', currency: 'BRL' });

    const ledgerResponse = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=50`);
    expect(ledgerResponse.status).toBe(200);
    const ledger = await ledgerResponse.json();
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries.every((entry: { money: { amount: unknown } }) => typeof entry.money.amount === 'string'))
      .toBe(true);

    const transactionResponse = await fetch(`${baseUrl}/wagering/transactions/${transactionId}`);
    expect(transactionResponse.status).toBe(200);
    expect((await transactionResponse.json()).transactionId).toBe(transactionId);

    const providerResponse = await fetch(
      `${baseUrl}/providers/${payload.providerId}/wagering/transactions/${payload.externalTransactionId}`,
    );
    expect(providerResponse.status).toBe(200);
    expect((await providerResponse.json()).transactionId).toBe(transactionId);

    expect((await fetch(`${baseUrl}/wagering/transactions/${randomUUID()}`)).status).toBe(404);
  });

  async function createWallet(initialAmount: string): Promise<{ id: string; playerId: string }> {
    const playerId = randomUUID();
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: initialAmount, currency: 'BRL' },
      }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  function wagerPayload(
    walletId: string,
    playerId: string,
    kind: 'BET' | 'REFUND',
    amount: string,
  ) {
    return {
      providerId: `provider-http-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'game-http-contract',
      kind,
      money: { amount, currency: 'BRL' },
    };
  }

  function postWager(payload: Record<string, unknown>, idempotencyKey?: string): Promise<Response> {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  }
});
