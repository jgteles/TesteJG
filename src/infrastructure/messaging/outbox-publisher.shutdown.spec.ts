import { describe, expect, it } from 'bun:test';
import { OutboxPublisherService } from './outbox-publisher.service';

describe('OutboxPublisherService lifecycle', () => {
  it('starts its publish loop with the application and stops it on shutdown', async () => {
    const publisher = new OutboxPublisherService({} as never);
    let finishPublish!: () => void;
    let publications = 0;
    publisher.publishPending = async () => {
      publications += 1;
      await new Promise<void>((resolve) => { finishPublish = resolve; });
      return { selected: 0, published: 0, failed: 0 };
    };

    publisher.onApplicationBootstrap();
    expect(publications).toBe(1);

    const shutdown = publisher.beforeApplicationShutdown();
    finishPublish();
    await shutdown;
    publisher.onModuleDestroy();

    expect(publications).toBe(1);
  });
});
