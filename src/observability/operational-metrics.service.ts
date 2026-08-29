import { Controller, Get, Injectable } from '@nestjs/common';

export interface OperationalMetricsSnapshot {
  transactionsByStatus: Record<string, number>;
  duplicatesDetected: number;
  retries: number;
  messagesSentToDlq: number;
  lockConflicts: number;
  outboxLagMilliseconds: number;
  processingCount: number;
  processingLatencyMillisecondsTotal: number;
  reconciliationDivergences: number;
}

@Injectable()
export class OperationalMetricsService {
  private readonly values: OperationalMetricsSnapshot = {
    transactionsByStatus: {},
    duplicatesDetected: 0,
    retries: 0,
    messagesSentToDlq: 0,
    lockConflicts: 0,
    outboxLagMilliseconds: 0,
    processingCount: 0,
    processingLatencyMillisecondsTotal: 0,
    reconciliationDivergences: 0,
  };

  transaction(status: string, duplicate: boolean, elapsedMilliseconds: number): void {
    this.values.transactionsByStatus[status] = (this.values.transactionsByStatus[status] ?? 0) + 1;
    if (duplicate) this.values.duplicatesDetected += 1;
    this.values.processingCount += 1;
    this.values.processingLatencyMillisecondsTotal += elapsedMilliseconds;
  }

  retry(): void { this.values.retries += 1; }
  dlq(): void { this.values.messagesSentToDlq += 1; }
  lockConflict(): void { this.values.lockConflicts += 1; }
  outboxLag(milliseconds: number): void { this.values.outboxLagMilliseconds = milliseconds; }
  reconciliationDivergence(): void { this.values.reconciliationDivergences += 1; }

  snapshot(): OperationalMetricsSnapshot {
    return { ...this.values, transactionsByStatus: { ...this.values.transactionsByStatus } };
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: OperationalMetricsService) {}

  @Get()
  getMetrics(): OperationalMetricsSnapshot {
    return this.metrics.snapshot();
  }
}
