export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(currencyA: string, currencyB: string) {
    super(`Currency mismatch: ${currencyA} and ${currencyB}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('Insufficient funds');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(currentStatus: string, expectedStatus?: string) {
    super(
      expectedStatus
        ? `Cannot transition from ${currentStatus} to ${expectedStatus}`
        : `Invalid transaction state: ${currentStatus}`,
    );
  }
}

export class LedgerBalanceMismatchError extends DomainError {
  constructor() {
    super('Ledger balance verification failed');
  }
}
