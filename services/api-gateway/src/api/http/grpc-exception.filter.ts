import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { isServiceError, toHttpError, type StructuredLogger } from '@artauction/platform';

/**
 * Responde con la misma forma JSON que el monolito ({ statusCode, message,
 * error }). Los errores gRPC de los servicios se traducen a su codigo HTTP; un
 * error inesperado del propio gateway sale como 500 sin detalles.
 */
@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      response
        .status(exception.getStatus())
        .json(typeof payload === 'string' ? { statusCode: exception.getStatus(), message: payload } : payload);
      return;
    }
    const body = toHttpError(exception);
    if (!isServiceError(exception) || body.statusCode >= 500) {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception), undefined, 'http');
    }
    response.status(body.statusCode).json(body);
  }
}
