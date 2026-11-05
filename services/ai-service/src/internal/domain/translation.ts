// Traduccion de la ficha de una obra entre los idiomas de la plataforma. Aqui
// vive solo la logica pura: que idiomas hay, como se trocea un texto largo y
// que campo se traduce o se copia. El modelo y el detector son puertos.

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Textos de una ficha que se traducen. La procedencia es opcional. */
export interface LotTexts {
  title: string;
  description: string;
  materials: string;
  provenance: string | null;
}

export interface LotTranslation {
  locale: Locale;
  texts: LotTexts;
}

/** Idiomas a los que se traduce una ficha escrita en `source`. */
export function targetLocales(source: Locale): Locale[] {
  return LOCALES.filter((locale) => locale !== source);
}

/**
 * Largo maximo de un trozo que se manda al modelo. Opus-MT admite unos 512
 * tokens; con 400 caracteres queda margen incluso en textos densos.
 */
export const MAX_CHUNK_LENGTH = 400;

/**
 * Trocea un texto para traducirlo sin pasar el limite del modelo: respeta los
 * parrafos, y dentro de cada uno junta oraciones mientras quepan. Una oracion
 * mas larga que el limite se parte por palabras. Devuelve los trozos y como
 * volver a unirlos.
 */
export function splitForTranslation(text: string, limit = MAX_CHUNK_LENGTH): { chunks: string[]; join: (translated: string[]) => string } {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  const sizes: number[] = [];
  for (const paragraph of paragraphs) {
    const sentences = paragraph.trim().match(/[^.!?¿¡]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [];
    const pieces: string[] = [];
    let current = '';
    const flush = () => {
      if (current.trim()) {
        pieces.push(current.trim());
      }
      current = '';
    };
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) {
        continue;
      }
      if (sentence.length > limit) {
        flush();
        pieces.push(...splitByWords(sentence, limit));
        continue;
      }
      if (current && current.length + 1 + sentence.length > limit) {
        flush();
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    flush();
    chunks.push(...pieces);
    sizes.push(pieces.length);
  }
  const join = (translated: string[]) => {
    let index = 0;
    return sizes
      .map((size) => {
        const part = translated.slice(index, index + size).join(' ');
        index += size;
        return part;
      })
      .filter((part) => part.length > 0)
      .join('\n\n');
  };
  return { chunks, join };
}

function splitByWords(sentence: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const word of sentence.split(/\s+/)) {
    if (current && current.length + 1 + word.length > limit) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

/**
 * Lo que nunca se traduce: direcciones web, correos y texto entre comillas
 * (titulos de obras, nombres citados). Opus-MT inventa contenido cuando una
 * oracion mezcla idiomas y desfigura nombres y dominios; un marcador opaco
 * como ZXQ0, en cambio, pasa intacto.
 */
const PROTECTED = new RegExp(
  [
    String.raw`https?:\/\/[^\s)\]]+`,
    String.raw`\bwww\.[^\s)\]]+`,
    String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
    String.raw`\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|co|es|edu|gov|art|museum)(?:\/[^\s)\]]*)?`,
    '«[^»]+»',
    '“[^”]+”',
    '"[^"]+"',
  ].join('|'),
  'g',
);

const MARKER = /ZXQ(\d+)/g;

/**
 * Cambia por marcadores lo que no debe traducirse. `restore` los devuelve a
 * su lugar en el texto traducido, o devuelve null si el modelo perdio o
 * altero alguno: en ese caso quien llama conserva el original.
 */
export function protectSegments(text: string): { masked: string; restore: (translated: string) => string | null } {
  const kept: string[] = [];
  const masked = text.replace(PROTECTED, (segment) => {
    kept.push(segment);
    return `ZXQ${String(kept.length - 1)}`;
  });
  const restore = (translated: string) => {
    const found = [...translated.matchAll(MARKER)].map((match) => Number(match[1]));
    if (found.length !== kept.length || kept.some((_segment, index) => !found.includes(index))) {
      return null;
    }
    return translated.replace(MARKER, (_marker, index: string) => kept[Number(index)] ?? '');
  };
  return { masked, restore };
}

/**
 * El texto sin lo protegido, para detectar su idioma: una descripcion en
 * espanol que cita un titulo y un material en ingles sigue siendo espanol.
 */
export function withoutProtected(text: string): string {
  return text.replace(PROTECTED, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Con algunas palabras sueltas Opus-MT entra en un ciclo y repite una silaba
 * hasta el tope ("oh, oh, oh..."). Ninguna traduccion legitima triplica el texto.
 */
export function outgrewOriginal(original: string, translated: string): boolean {
  return translated.length > original.length * 3 + 40;
}

const NUMBER = /\d+/g;
const ROMAN = /\b[IVXLC]+\b/g;
const ROMAN_VALUES: Readonly<Record<string, number>> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

function romanValue(numeral: string): number {
  const values = numeral.split('').map((letter) => ROMAN_VALUES[letter] ?? 0);
  return values.reduce((total, value, index) => total + (value < (values[index + 1] ?? 0) ? -value : value), 0);
}

/**
 * Opus-MT a veces agrega datos que no estaban (medidas, fechas). Una
 * traduccion solo es aceptable si cada numero que trae ya estaba en el original.
 */
export function introducesNumbers(original: string, translated: string): boolean {
  // "siglo XIX" se traduce bien como "19th century": un romano cuenta como su numero.
  const romans = (original.match(ROMAN) ?? []).map((numeral) => String(romanValue(numeral)));
  const known = new Set([...(original.match(NUMBER) ?? []), ...romans]);
  return (translated.match(NUMBER) ?? []).some((number) => !known.has(number));
}

/**
 * Por debajo de este largo un detector de idioma acierta poco (una o dos
 * palabras): esos campos se asumen en el idioma de la ficha.
 */
export const MIN_DETECTABLE_LENGTH = 12;
