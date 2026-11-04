import type { ErrorCode, ErrorParams } from './error-codes';

/**
 * Categorias de error que la capa interna de un servicio puede expresar sin
 * conocer el transporte. La capa api traduce cada categoria a un status gRPC y
 * el gateway la traduce a un codigo HTTP.
 */
export const DOMAIN_ERROR_KINDS = [
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'CONFLICT',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'FAILED_PRECONDITION',
  'UNAVAILABLE',
] as const;

export type DomainErrorKind = (typeof DOMAIN_ERROR_KINDS)[number];

/** Codigo estable y parametros para que el cliente muestre el error en su idioma. */
export interface DomainErrorOptions {
  code?: ErrorCode;
  params?: ErrorParams;
}

export class DomainError extends Error {
  readonly code: ErrorCode | undefined;
  readonly params: ErrorParams;

  constructor(
    readonly kind: DomainErrorKind,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = options.code;
    this.params = options.params ?? {};
  }

  static invalid(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError('INVALID_ARGUMENT', message, options);
  }

  static notFound(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError('NOT_FOUND', message, options);
  }

  static conflict(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError('CONFLICT', message, options);
  }

  static forbidden(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError('PERMISSION_DENIED', message, options);
  }

  static unauthenticated(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError('UNAUTHENTICATED', message, options);
  }

  static precondition(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError('FAILED_PRECONDITION', message, options);
  }

  static unavailable(message: string, options?: DomainErrorOptions): DomainError {
    return new DomainError('UNAVAILABLE', message, options);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
