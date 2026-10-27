import { Metadata, status, type ServiceError } from '@grpc/grpc-js';
import { isDomainError, type DomainErrorKind } from '../errors/domain-error';

const KIND_TO_STATUS: Readonly<Record<DomainErrorKind, status>> = {
  INVALID_ARGUMENT: status.INVALID_ARGUMENT,
  NOT_FOUND: status.NOT_FOUND,
  CONFLICT: status.ALREADY_EXISTS,
  PERMISSION_DENIED: status.PERMISSION_DENIED,
  UNAUTHENTICATED: status.UNAUTHENTICATED,
  FAILED_PRECONDITION: status.FAILED_PRECONDITION,
  UNAVAILABLE: status.UNAVAILABLE,
};

export interface HttpErrorShape {
  statusCode: number;
  error: string;
  message: string;
}

const STATUS_TO_HTTP: ReadonlyMap<status, { statusCode: number; error: string }> = new Map([
  [status.INVALID_ARGUMENT, { statusCode: 400, error: 'Bad Request' }],
  [status.OUT_OF_RANGE, { statusCode: 400, error: 'Bad Request' }],
  [status.UNAUTHENTICATED, { statusCode: 401, error: 'Unauthorized' }],
  [status.PERMISSION_DENIED, { statusCode: 403, error: 'Forbidden' }],
  [status.NOT_FOUND, { statusCode: 404, error: 'Not Found' }],
  [status.ALREADY_EXISTS, { statusCode: 409, error: 'Conflict' }],
  [status.ABORTED, { statusCode: 409, error: 'Conflict' }],
  [status.FAILED_PRECONDITION, { statusCode: 409, error: 'Conflict' }],
  [status.RESOURCE_EXHAUSTED, { statusCode: 429, error: 'Too Many Requests' }],
  [status.UNAVAILABLE, { statusCode: 503, error: 'Service Unavailable' }],
  [status.DEADLINE_EXCEEDED, { statusCode: 504, error: 'Gateway Timeout' }],
]);

const INTERNAL_MESSAGE = 'Error interno del servicio';

/**
 * Convierte cualquier error en un ServiceError de gRPC. Un DomainError conserva
 * su mensaje porque esta pensado para el usuario; cualquier otro error se
 * reporta como INTERNAL con un mensaje generico para no filtrar detalles.
 */
export function toServiceError(error: unknown): ServiceError {
  if (isServiceError(error)) {
    return error;
  }
  const code = isDomainError(error) ? KIND_TO_STATUS[error.kind] : status.INTERNAL;
  const message = isDomainError(error) ? error.message : INTERNAL_MESSAGE;
  return Object.assign(new Error(message), {
    code,
    details: message,
    metadata: new Metadata(),
  });
}

export function isServiceError(value: unknown): value is ServiceError {
  return (
    value instanceof Error &&
    'code' in value &&
    typeof value.code === 'number' &&
    'details' in value &&
    'metadata' in value
  );
}

/** Traduce un error gRPC a la forma JSON que devolvia el monolito NestJS. */
export function toHttpError(error: unknown): HttpErrorShape {
  if (!isServiceError(error)) {
    return { statusCode: 500, error: 'Internal Server Error', message: INTERNAL_MESSAGE };
  }
  const mapped = STATUS_TO_HTTP.get(error.code);
  if (!mapped) {
    return { statusCode: 500, error: 'Internal Server Error', message: INTERNAL_MESSAGE };
  }
  return { ...mapped, message: error.details || INTERNAL_MESSAGE };
}
