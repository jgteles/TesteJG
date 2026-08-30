import { access } from 'node:fs/promises';
import { MikroORM } from '@mikro-orm/core';
import { DeleteMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import config from '../src/mikro-orm.config';
import type { SubmitWagerTransactionInput } from '../src/application/use-cases/submit-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from '../src/application/use-cases/submit-wager-transaction.use-case';
import { OutboxPublisherService } from '../src/infrastructure/messaging/outbox-publisher.service';
import { WagerTransactionsConsumerService } from '../src/infrastructure/messaging/wager-transactions-consumer.service';

const command = process.argv[2];
const argument = process.argv[3];

function decode<T>(value: string | undefined): T {
  if (!value) throw new Error('Missing worker argument');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function emit(name: string, value?: unknown): void {
  process.stdout.write(`${name}${value === undefined ? '' : `:${JSON.stringify(value)}`}\n`);
}

async function waitForBarrier(path: string): Promise<void> {
  emit('READY');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Barrier was not released: ${path}`);
}

async function submitWager(): Promise<void> {
  const input = decode<SubmitWagerTransactionInput>(argument);
  const barrierPath = process.argv[4];
  const orm = await MikroORM.init(config);
  try {
    if (barrierPath) await waitForBarrier(barrierPath);
    const result = await new SubmitWagerTransactionUseCase(orm).execute(input);
    emit('RESULT', result);
  } finally {
    await orm.close();
  }
}

async function crashConsumerBeforeAck(): Promise<void> {
  const { queueUrl } = decode<{ queueUrl: string }>(argument);
  const orm = await MikroORM.init(config);
  const consumer = new WagerTransactionsConsumerService(orm, new SubmitWagerTransactionUseCase(orm));
  const transport = consumer as unknown as {
    sqs: { send: (command: unknown) => Promise<unknown> };
  };
  const send = transport.sqs.send.bind(transport.sqs);
  transport.sqs.send = async (sqsCommand: unknown): Promise<unknown> => {
    if (sqsCommand instanceof DeleteMessageCommand) {
      emit('COMMITTED_BEFORE_ACK');
      return new Promise<never>(() => undefined);
    }
    return send(sqsCommand);
  };

  await consumer.consumeOnce(1, queueUrl);
}

async function consumeRedelivery(): Promise<void> {
  const { queueUrl } = decode<{ queueUrl: string }>(argument);
  const orm = await MikroORM.init(config);
  const consumer = new WagerTransactionsConsumerService(orm, new SubmitWagerTransactionUseCase(orm));
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const result = await consumer.consumeOnce(1, queueUrl);
      if (result.received > 0) {
        emit('RESULT', result);
        return;
      }
    }
    throw new Error('The committed SQS message was not redelivered');
  } finally {
    await consumer.beforeApplicationShutdown();
    await orm.close();
  }
}

async function crashPublisherAfterSend(): Promise<void> {
  const { queueUrl } = decode<{ queueUrl: string }>(argument);
  const orm = await MikroORM.init(config);
  const publisher = new OutboxPublisherService(orm);
  const transport = publisher as unknown as {
    sqs: { send: (command: unknown) => Promise<unknown> };
  };
  const send = transport.sqs.send.bind(transport.sqs);
  transport.sqs.send = async (sqsCommand: unknown): Promise<unknown> => {
    const result = await send(sqsCommand);
    if (sqsCommand instanceof SendMessageCommand) {
      emit('SQS_ACCEPTED_BEFORE_DATABASE_UPDATE');
      return new Promise<never>(() => undefined);
    }
    return result;
  };

  await publisher.publishPending(1, queueUrl);
}

async function publishPending(): Promise<void> {
  const { queueUrl } = decode<{ queueUrl: string }>(argument);
  const orm = await MikroORM.init(config);
  const publisher = new OutboxPublisherService(orm);
  try {
    emit('RESULT', await publisher.publishPending(1, queueUrl));
  } finally {
    publisher.onModuleDestroy();
    await orm.close();
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'submit':
      await submitWager();
      break;
    case 'crash-consumer-before-ack':
      await crashConsumerBeforeAck();
      break;
    case 'consume-redelivery':
      await consumeRedelivery();
      break;
    case 'crash-publisher-after-send':
      await crashPublisherAfterSend();
      break;
    case 'publish-pending':
      await publishPending();
      break;
    default:
      throw new Error(`Unknown distributed test command: ${command}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
