import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

interface PendingOutboxRow {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface PublishOutboxResult {
  selected: number;
  published: number;
  failed: number;
}

@Injectable()
export class OutboxPublisherService {
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

  async publishPending(limit = 10, queueUrl = this.queueUrl): Promise<PublishOutboxResult> {
    return this.orm.em.transactional(async (em) => {
      const sqlEm = em as unknown as PostgreSqlEntityManager;
      const rows = await sqlEm.execute(
        `select id, aggregate_id, payload
         from outbox_messages
         where status = 'PENDING'
           and published_at is null
           and next_attempt_at <= now()
         order by created_at, id
         for update skip locked
         limit ?`,
        [limit],
      ) as PendingOutboxRow[];
      let published = 0;
      let failed = 0;

      for (const row of rows) {
        const walletId = this.walletIdFrom(row);
        try {
          await this.sqs.send(new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(row.payload),
            MessageGroupId: walletId,
            MessageDeduplicationId: row.id,
          }));
          await sqlEm.execute(
            `update outbox_messages
             set status = 'PUBLISHED', published_at = now(), updated_at = now(), attempts = attempts + 1
             where id = ?`,
            [row.id],
          );
          published += 1;
        } catch {
          await sqlEm.execute(
            `update outbox_messages
             set updated_at = now(), attempts = attempts + 1
             where id = ?`,
            [row.id],
          );
          failed += 1;
        }
      }

      return { selected: rows.length, published, failed };
    });
  }

  private walletIdFrom(row: PendingOutboxRow): string {
    const data = row.payload.data;
    if (data && typeof data === 'object' && 'walletId' in data) {
      const walletId = (data as { walletId?: unknown }).walletId;
      if (typeof walletId === 'string' && walletId.length > 0) return walletId;
    }
    return row.aggregate_id;
  }
}
