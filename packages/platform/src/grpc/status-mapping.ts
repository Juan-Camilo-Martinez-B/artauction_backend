import { Metadata, status, type ServiceError } from '@grpc/grpc-js';
import { METADATA_KEYS } from '../context/request-context';
import { isDomainError, type DomainErrorKind, type DomainErrorOptions } from '../errors/domain-error';
import { isErrorCode, type ErrorCode, type ErrorParams, type GenericErrorCode } from '../errors/error-codes';

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
  /** Codigo estable para que el cliente muestre el error en su idioma. */
  code: ErrorCode | GenericErrorCode;
  params?: ErrorParams;
}

const STATUS_TO_HTTP: ReadonlyMap<status, { statusCode: number; error: string; code: GenericErrorCode }> = new Map([
  [status.INVALID_ARGUMENT, { statusCode: 400, error: 'Bad Request', code: 'INVALID_ARGUMENT' }],
  [status.OUT_OF_RANGE, { statusCode: 400, error: 'Bad Request', code: 'INVALID_ARGUMENT' }],
  [status.UNAUTHENTICATED, { statusCode: 401, error: 'Unauthorized', code: 'UNAUTHENTICATED' }],
  [status.PERMISSION_DENIED, { statusCode: 403, error: 'Forbidden', code: 'PERMISSION_DENIED' }],
  [status.NOT_FOUND, { statusCode: 404, error: 'Not Found', code: 'NOT_FOUND' }],
  [status.ALREADY_EXISTS, { statusCode: 409, error: 'Conflict', code: 'CONFLICT' }],
  [status.ABORTED, { statusCode: 409, error: 'Conflict', code: 'CONFLICT' }],
  [status.FAILED_PRECONDITION, { statusCode: 409, error: 'Conflict', code: 'FAILED_PRECONDITION' }],
  [status.RESOURCE_EXHAUSTED, { statusCode: 429, error: 'Too Many Requests', code: 'RATE_LIMITED' }],
  [status.UNAVAILABLE, { statusCode: 503, error: 'Service Unavailable', code: 'UNAVAILABLE' }],
  [status.DEADLINE_EXCEEDED, { statusCode: 504, error: 'Gateway Timeout', code: 'TIMEOUT' }],
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
  const metadata = new Metadata();
  if (isDomainError(error) && error.code) {
    metadata.set(METADATA_KEYS.errorCode, error.code);
    if (Object.keys(error.params).length > 0) {
      metadata.set(METADATA_KEYS.errorParams, JSON.stringify(error.params));
    }
  }
  return Object.assign(new Error(message), { code, details: message, metadata });
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
    return INTERNAL_ERROR;
  }
  const mapped = STATUS_TO_HTTP.get(error.code);
  if (!mapped) {
    return INTERNAL_ERROR;
  }
  const specific = error.metadata.get(METADATA_KEYS.errorCode)[0];
  const params = readParams(error.metadata.get(METADATA_KEYS.errorParams)[0]);
  return {
    statusCode: mapped.statusCode,
    error: mapped.error,
    message: error.details || INTERNAL_MESSAGE,
    code: isErrorCode(specific) ? specific : mapped.code,
    ...(params ? { params } : {}),
  };
}

/**
 * Codigo y parametros que trae un error gRPC de otro servicio, para conservarlos
 * cuando quien llama lo vuelve a lanzar como DomainError propio.
 */
export function errorOptionsFrom(error: ServiceError): DomainErrorOptions {
  const code = error.metadata.get(METADATA_KEYS.errorCode)[0];
  const params = readParams(error.metadata.get(METADATA_KEYS.errorParams)[0]);
  return { ...(isErrorCode(code) ? { code } : {}), ...(params ? { params } : {}) };
}

const INTERNAL_ERROR: HttpErrorShape = { statusCode: 500, error: 'Internal Server Error', message: INTERNAL_MESSAGE, code: 'INTERNAL' };

/** Solo pasan parametros de texto: lo que llega por la red no se reenvia sin revisar. */
function readParams(raw: unknown): ErrorParams | null {
  if (typeof raw !== 'string' || raw.length > 1_000) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}
