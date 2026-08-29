import { describe, expect, it } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitWagerTransactionDto } from './submit-wager-transaction.dto';

const validPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('SubmitWagerTransactionDto', () => {
  it('accepts the request contract documented in README.md', async () => {
    const dto = plainToInstance(SubmitWagerTransactionDto, validPayload);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects the old flat amount contract', async () => {
    const { money: _money, ...oldPayload } = validPayload;
    const dto = plainToInstance(SubmitWagerTransactionDto, {
      ...oldPayload,
      amount: '25.00',
      currency: 'BRL',
    });

    expect((await validate(dto)).some((error) => error.property === 'money')).toBe(true);
  });

  it('rejects invalid monetary values', async () => {
    const dto = plainToInstance(SubmitWagerTransactionDto, {
      ...validPayload,
      money: { amount: '1.234', currency: 'BRL' },
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
