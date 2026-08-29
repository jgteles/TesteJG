import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { CurrencyMismatchError, DomainError, InvalidMoneyError } from '../../domain/errors';

@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof UniqueConstraintViolationException) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        message: 'Resource already exists or conflicts with an existing transaction',
        error: 'Conflict',
      });
      return;
    }

    if (exception instanceof CurrencyMismatchError || exception instanceof InvalidMoneyError) {
      const error = new BadRequestException(exception.message);
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }

    if (exception instanceof DomainError) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: exception.message,
        error: 'Unprocessable Entity',
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
