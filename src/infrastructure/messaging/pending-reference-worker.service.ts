import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager as PostgreSqlEntityManager } from '@mikro-orm/postgresql';
import { ReprocessPendingReferenceUseCase } from '../../application/use-cases/reprocess-pending-reference.use-case';

export const MAX_PENDING_REFERENCE_ATTEMPTS = 5;
export const PENDING_REFERENCE_BACKOFF_BASE_MS = 1_000;

interface ClaimedPendingReference {
  id: string;
  reference_attempts: number;
}

@Injectable()
export class PendingReferenceWorkerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorkerService.name);
  private running = true;
  private workerLoop?: Promise<void>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private finishPollWait?: () => void;

  constructor(
    private readonly orm: MikroORM,
    private readonly reprocess: ReprocessPendingReferenceUseCase,
  ) {}

  onApplicationBootstrap(): void {
    this.workerLoop = this.runLoop();
  }

  async processDueOnce(now = new Date(), limit = 10): Promise<number> {
    const claimed = await this.orm.em.transactional(async (em) => {
      const sqlEm = em as unknown as PostgreSqlEntityManager;
      return sqlEm.execute(
        `with candidates as (
           select id
           from wager_transactions
           where status = 'PENDING_REFERENCE'
             and next_reference_attempt_at <= ?::timestamptz
           order by next_reference_attempt_at, id
           for update skip locked
           limit ?
         )
         update wager_transactions as transaction
         set reference_attempts = transaction.reference_attempts + 1,
             next_reference_attempt_at = ?::timestamptz + (
               interval '1 millisecond' * (? * power(2, transaction.reference_attempts))
             )
         from candidates
         where transaction.id = candidates.id
         returning transaction.id, transaction.reference_attempts`,
        [now, limit, now, PENDING_REFERENCE_BACKOFF_BASE_MS],
      ) as Promise<ClaimedPendingReference[]>;
    });

    for (const transaction of claimed) {
      await this.reprocess.execute(
        transaction.id,
        transaction.reference_attempts >= MAX_PENDING_REFERENCE_ATTEMPTS,
      );
    }

    return claimed.length;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.finishPollWait?.();
    await this.workerLoop;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.processDueOnce();
      } catch (error) {
        if (this.running) {
          this.logger.error({ event: 'pending_reference_worker_failed', error: String(error) });
        }
      }
      if (this.running) await this.waitForNextPoll();
    }
  }

  private waitForNextPoll(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.finishPollWait = resolve;
      this.pollTimer = setTimeout(resolve, 250);
    }).finally(() => {
      this.pollTimer = undefined;
      this.finishPollWait = undefined;
    });
  }
}
