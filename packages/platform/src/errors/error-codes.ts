/**
 * Codigos estables de los errores que ve una persona. El mensaje de un
 * DomainError esta en espanol y sirve para logs y como respaldo; el frontend
 * muestra el texto de su diccionario segun este codigo, en el idioma de quien
 * mira. Un codigo publicado no cambia de significado: si cambia la regla, se
 * agrega otro.
 *
 * Un error sin codigo propio llega al cliente con el codigo generico de su
 * categoria (ver GENERIC_ERROR_CODES).
 */
export const ERROR_CODES = [
  // identity
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'SESSION_INVALID',
  'ROLE_NOT_ALLOWED',
  'ACCOUNT_NOT_FOUND',
  'USER_NOT_FOUND',
  // catalogo
  'LOT_NOT_FOUND',
  'LOT_CHANGED',
  'LOT_NOT_EDITABLE',
  'LOT_VISIBILITY_FIXED',
  'MODEL_ONLY_THREE_D',
  'MODEL_REQUIRED',
  'MODEL_REMOVE_PUBLIC',
  'SELLER_ONLY',
  'ADMIN_ONLY',
  // subastas
  'AUCTION_NOT_FOUND',
  'AUCTION_NOT_ACTIVE',
  'AUCTION_CLOSED',
  'AUCTION_ALREADY_EXISTS',
  'LOT_NOT_READY_FOR_AUCTION',
  'BID_BELOW_INCREMENT',
  'BID_TAKEN',
  'BID_ALREADY_PLACED',
  'OWN_LOT_BID',
  'OWN_LOT_PURCHASE',
  'WITHDRAW_LOCKED',
  'BUY_NOW_EXCEEDED',
  'BUY_NOW_ROOM_CLOSED',
  'IDEMPOTENCY_KEY_REUSED',
  // bolsillo
  'INSUFFICIENT_FUNDS',
  'PAYMENT_REJECTED',
  'TOP_UP_OUT_OF_RANGE',
  'WALLET_UNAVAILABLE',
  // galeria
  'GALLERY_NOT_FOUND',
  'GALLERY_MANUAL_CHANGES',
  'ARTWORK_NOT_OWNED',
  'ARTWORK_NEEDS_MODEL',
  'ARTWORK_NOT_IN_GALLERY',
  'SHEET_NOT_FOUND',
  // IA
  'AI_NOT_CONFIGURED',
  'AI_UNAVAILABLE',
  'TRANSLATION_DISABLED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codigos genericos que el gateway pone cuando el error no trae uno propio:
 * la categoria del error y los fallos del propio HTTP.
 */
export const GENERIC_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'CONFLICT',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'FAILED_PRECONDITION',
  'UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'INVALID_JSON',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
] as const;

export type GenericErrorCode = (typeof GENERIC_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

/** Parametros de un mensaje: valores ya formateados que el texto intercala. */
export type ErrorParams = Readonly<Record<string, string>>;
