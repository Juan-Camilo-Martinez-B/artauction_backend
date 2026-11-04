// Comprobaciones de forma para datos que llegan sin tipo: JSON de un modelo de
// IA, columnas JSONB, mensajes de un socket o identificadores de una ruta.

/** Objeto JSON plano: ni null ni un arreglo. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identificador UUID en su forma canonica (8-4-4-4-12 en hexadecimal, sin
 * distinguir mayusculas). Se comprueba antes de consultar la base: Postgres
 * rechaza un uuid mal formado con un error, no con "no encontrado".
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
