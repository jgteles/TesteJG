import { describe, expect, it } from 'bun:test';
import { PendingReferenceWorkerService } from './pending-reference-worker.service';

describe('PendingReferenceWorkerService lifecycle', () => {
  it('starts automatically and stops its loop during shutdown', async () => {
    const worker = new PendingReferenceWorkerService({} as never, {} as never);
    let finishAttempt!: () => void;
    let attempts = 0;
    worker.processDueOnce = async () => {
      attempts += 1;
      await new Promise<void>((resolve) => { finishAttempt = resolve; });
      return 0;
    };

    worker.onApplicationBootstrap();
    expect(attempts).toBe(1);

    const shutdown = worker.beforeApplicationShutdown();
    finishAttempt();
    await shutdown;
    expect(attempts).toBe(1);
  });
});
