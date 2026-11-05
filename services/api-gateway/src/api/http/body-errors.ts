import { STATUS_CODES } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { GenericErrorCode } from '@artauction/platform';

interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { type?: unknown; status?: unknown };
  return typeof record.type === 'string' && record.type.startsWith('entity.') && typeof record.status === 'number';
}

const BODY_ERRORS: Readonly<Record<string, { message: string; code: GenericErrorCode }>> = {
  'entity.too.large': { message: 'El cuerpo de la peticion es demasiado grande', code: 'PAYLOAD_TOO_LARGE' },
  'entity.parse.failed': { message: 'El cuerpo de la peticion no es JSON valido', code: 'INVALID_JSON' },
};

/**
 * Responde los fallos del parser de JSON (cuerpo mal formado o demasiado
 * grande) con la forma de error del gateway y un mensaje propio: el del parser
 * describe el contenido recibido y no se reenvia. Va justo despues de json(),
 * antes de que Nest los convierta en un 400 generico.
 */
export function bodyErrors(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (!isBodyParserError(error) || error.status < 400 || error.status >= 500) {
    next(error);
    return;
  }
  const known = BODY_ERRORS[error.type] ?? { message: 'El cuerpo de la peticion no es valido', code: 'INVALID_ARGUMENT' as const };
  response.status(error.status).json({
    statusCode: error.status,
    error: STATUS_CODES[error.status] ?? 'Bad Request',
    message: known.message,
    code: known.code,
  });
}
