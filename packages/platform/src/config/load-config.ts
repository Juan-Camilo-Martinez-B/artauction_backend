import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, validateSync } from 'class-validator';

type ConfigClass<T> = new () => T;
type Coercion = 'number' | 'boolean' | 'string';

const NUMERIC_RULES = new Set(['isInt', 'isNumber', 'min', 'max', 'isPort']);
const BOOLEAN_RULES = new Set(['isBoolean']);

/**
 * Construye y valida la configuracion de un servicio a partir de variables de
 * entorno. Solo se leen las propiedades que la clase declara con decoradores de
 * class-validator, asi una variable ajena al servicio nunca entra en su config.
 * Los valores ausentes conservan el valor por defecto de la clase. El tipo de
 * cada variable se deduce del valor por defecto o de sus validadores, sin
 * depender de los metadatos de tipo que emite el compilador.
 */
export function loadConfig<T extends object>(
  target: ConfigClass<T>,
  source: NodeJS.ProcessEnv = process.env,
): T {
  const plain: Record<string, string | number | boolean> = {};
  for (const [key, coercion] of declaredKeys(target)) {
    const value = source[key];
    if (value !== undefined && value !== '') {
      plain[key] = coerce(value, coercion);
    }
  }
  const config = plainToInstance(target, plain);
  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detail = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Configuracion invalida: ${detail}`);
  }
  return config;
}

function declaredKeys(target: ConfigClass<object>): Map<string, Coercion> {
  const defaults = new target() as Record<string, unknown>;
  const metadata = getMetadataStorage().getTargetValidationMetadatas(target, '', true, false);
  const keys = new Map<string, Coercion>();
  for (const entry of metadata) {
    const fallback = defaults[entry.propertyName];
    const rule = entry.name ?? '';
    const current = keys.get(entry.propertyName) ?? 'string';
    if (typeof fallback === 'number' || NUMERIC_RULES.has(rule)) {
      keys.set(entry.propertyName, 'number');
    } else if (typeof fallback === 'boolean' || BOOLEAN_RULES.has(rule)) {
      keys.set(entry.propertyName, 'boolean');
    } else {
      keys.set(entry.propertyName, current);
    }
  }
  return keys;
}

function coerce(value: string, coercion: Coercion): string | number | boolean {
  if (coercion === 'number') {
    return Number(value);
  }
  if (coercion === 'boolean') {
    return value === 'true' || value === '1';
  }
  return value;
}
