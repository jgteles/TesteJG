#!/usr/bin/env bash
set -euo pipefail

region="${AWS_DEFAULT_REGION:-us-east-1}"
account_id="000000000000"
base_url="http://localhost:4566"

awslocal() {
  AWS_DEFAULT_REGION="$region" aws --endpoint-url "$base_url" "$@"
}

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30

dead_letter_url="$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)"
dead_letter_arn="arn:aws:sqs:${region}:${account_id}:wager-transactions-dlq.fifo"
redrive_policy="{\"deadLetterTargetArn\":\"${dead_letter_arn}\",\"maxReceiveCount\":\"5\"}"
queue_attributes="{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"${redrive_policy//\"/\\\"}\"}"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$queue_attributes"

printf 'Created SQS queues:\n'
printf '  %s\n' "$dead_letter_url"
awslocal sqs get-queue-url --queue-name wager-transactions.fifo
