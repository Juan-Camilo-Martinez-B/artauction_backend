import { STATUS_CODES } from 'node:http';
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
    const client = clientError(exception);
    if (client) {
      response.status(client.statusCode).json(client);
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
 * Errores del parser de cuerpo (JSON mal formado, cuerpo demasiado grande):
 * traen un status 4xx y `expose`, que indica que el mensaje es seguro de mostrar.
 */
function clientError(exception: unknown): { statusCode: number; error: string; message: string } | null {
  if (typeof exception !== 'object' || exception === null) {
    return null;
  }
  const record = exception as { status?: unknown; expose?: unknown; message?: unknown };
  const status = typeof record.status === 'number' ? record.status : 0;
  if (record.expose !== true || status < 400 || status >= 500) {
    return null;
  }
  return {
    statusCode: status,
    error: STATUS_CODES[status] ?? 'Bad Request',
    message: status === 413 ? 'El cuerpo de la peticion es demasiado grande' : 'El cuerpo de la peticion no es JSON valido',
  };
}
