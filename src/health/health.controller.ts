import { Controller, Get, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(private readonly orm: MikroORM) {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
    this.queueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL
      ?? `${endpoint}/000000000000/wager-transactions.fifo`;
    this.sqs = new SQSClient({
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'connected'; sqs: 'connected' }> {
    try {
      await Promise.all([
        this.orm.em.getConnection().execute('SELECT 1'),
        this.sqs.send(new GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ['QueueArn'],
        })),
      ]);
      return { status: 'ok', database: 'connected', sqs: 'connected' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error' });
    }
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
