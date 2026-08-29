import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import config from '../mikro-orm.config';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    await orm.close();
  });

  it('reports liveness without checking dependencies', () => {
    const controller = new HealthController(orm);
    expect(controller.live()).toEqual({ status: 'ok' });
    controller.onModuleDestroy();
  });

  it('reports readiness only when PostgreSQL and SQS are accessible', async () => {
    const controller = new HealthController(orm);
    expect(await controller.ready()).toEqual({
      status: 'ok',
      database: 'connected',
      sqs: 'connected',
    });
    controller.onModuleDestroy();
  });

  it('reports service unavailable when the required SQS queue is inaccessible', async () => {
    const previousQueueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL;
    process.env.WAGER_TRANSACTIONS_QUEUE_URL =
      `${process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'}/000000000000/missing.fifo`;
    const controller = new HealthController(orm);
    try {
      await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    } finally {
      controller.onModuleDestroy();
      if (previousQueueUrl === undefined) delete process.env.WAGER_TRANSACTIONS_QUEUE_URL;
      else process.env.WAGER_TRANSACTIONS_QUEUE_URL = previousQueueUrl;
    }
  });
});
