import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { isServiceError, toHttpError, type GenericErrorCode, type StructuredLogger } from '@artauction/platform';

/**
 * Responde con la misma forma JSON que el monolito ({ statusCode, message,
 * error }) mas un codigo estable (code) que el frontend traduce al idioma de
 * quien mira. Los errores gRPC de los servicios se traducen a su codigo HTTP; un
 * error inesperado del propio gateway sale como 500 sin detalles.
 */
@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      const body = typeof payload === 'string' ? { statusCode, message: payload } : payload;
      response.status(statusCode).json({ ...body, code: httpCode(statusCode) });
      return;
    }
    const body = toHttpError(exception);
    if (!isServiceError(exception) || body.statusCode >= 500) {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception), undefined, 'http');
    }
    response.status(body.statusCode).json(body);
  }
}

/**
 * Codigo de un error HTTP del propio gateway: un 400 es la validacion de un
 * DTO, un 429 el limite de peticiones; el resto toma la categoria del status.
 */
function httpCode(statusCode: number): GenericErrorCode {
  switch (statusCode) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return statusCode >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT';
  }
}
