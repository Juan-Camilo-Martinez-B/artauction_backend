import type { Prisma } from '../../generated/prisma';
import type { Assessment } from '../domain/verdict';

// Evaluaciones y expedientes se guardan como JSONB. Al leerlos llegan sin tipo:
// estas guardas comprueban la forma antes de confiar en ellos.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAssessment(value: unknown): value is Assessment {
  return (
    isRecord(value) &&
    typeof value['model'] === 'string' &&
    typeof value['score'] === 'number' &&
    typeof value['critical'] === 'boolean' &&
    Array.isArray(value['findings'])
  );
}

/**
 * Un objeto del dominio como valor JSON de Prisma. Las interfaces del dominio no
 * declaran firma de indice, asi que TypeScript no las acepta tal cual; como son
 * datos planos (texto, numeros, arreglos), pasarlas por `object` no pierde nada.
 */
export function toJsonObject(value: object): Prisma.InputJsonObject {
  return value;
}
