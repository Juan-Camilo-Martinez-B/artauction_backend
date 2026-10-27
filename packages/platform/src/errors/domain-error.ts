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

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static invalid(message: string): DomainError {
    return new DomainError('INVALID_ARGUMENT', message);
  }

  static notFound(message: string): DomainError {
    return new DomainError('NOT_FOUND', message);
  }

  static conflict(message: string): DomainError {
    return new DomainError('CONFLICT', message);
  }

  static forbidden(message: string): DomainError {
    return new DomainError('PERMISSION_DENIED', message);
  }

  static unauthenticated(message: string): DomainError {
    return new DomainError('UNAUTHENTICATED', message);
  }

  static precondition(message: string): DomainError {
    return new DomainError('FAILED_PRECONDITION', message);
  }

  static unavailable(message: string): DomainError {
    return new DomainError('UNAVAILABLE', message);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
