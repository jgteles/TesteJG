import { describe, expect, it } from 'bun:test';
import { MetricsController, OperationalMetricsService } from './operational-metrics.service';

describe('OperationalMetricsService', () => {
  it('exposes exactly the operational metrics required by the README', () => {
    const metrics = new OperationalMetricsService();
    metrics.transaction('PROCESSED', false, 12);
    metrics.transaction('REJECTED', true, 8);
    metrics.retry();
    metrics.dlq();
    metrics.lockConflict();
    metrics.outboxLag(25);
    metrics.reconciliationDivergence();

    expect(new MetricsController(metrics).getMetrics()).toEqual({
      transactionsByStatus: { PROCESSED: 1, REJECTED: 1 },
      duplicatesDetected: 1,
      retries: 1,
      messagesSentToDlq: 1,
      lockConflicts: 1,
      outboxLagMilliseconds: 25,
      processingCount: 2,
      processingLatencyMillisecondsTotal: 20,
      reconciliationDivergences: 1,
    });
  });
});
