import { createHash } from 'node:crypto';

// Traduccion automatica de las fichas (F18). El original nunca se toca: las
// traducciones se guardan aparte y solo valen mientras el texto no cambie.

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Textos de una ficha que se traducen. */
export interface TranslatableTexts {
  title: string;
  description: string;
  materials: string;
  provenance: string | null;
}

/** Traduccion vigente de una ficha a un idioma. */
export interface LotTranslation extends TranslatableTexts {
  locale: Locale;
  /** Modelo que la hizo, por ejemplo opus-mt. */
  model: string;
}

/**
 * Separador de campos en la huella. Es el caracter de control "unit
 * separator": no aparece en un texto escrito, asi "a|b" y "a" + "b" nunca
 * dan la misma huella.
 */
export const TEXT_SEPARATOR = '\u001f';

/**
 * Huella (SHA-256) de los textos de una ficha. Debe coincidir con TEXT_HASH_SQL
 * del repositorio, que calcula lo mismo en Postgres para encontrar las fichas
 * sin traduccion vigente.
 */
export function textHash(texts: TranslatableTexts): string {
  return createHash('sha256')
    .update([texts.title, texts.description, texts.materials, texts.provenance ?? ''].join(TEXT_SEPARATOR), 'utf8')
    .digest('hex');
}

/** Intentos de traducir una misma version del texto antes de darla por fallida. */
export const TRANSLATION_MAX_ATTEMPTS = 5;

/** Espera antes del siguiente intento: 30 s, 1 min, 2 min, 4 min… hasta 30 min. */
export function translationRetryDelayMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}
