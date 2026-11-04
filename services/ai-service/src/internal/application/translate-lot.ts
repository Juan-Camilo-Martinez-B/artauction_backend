import { DomainError } from '@artauction/platform';
import {
  MIN_DETECTABLE_LENGTH,
  protectSegments,
  splitForTranslation,
  targetLocales,
  type Locale,
  type LotTexts,
  type LotTranslation,
} from '../domain/translation';
import type { LanguageDetector, Translator } from './ports';

const FIELDS = ['title', 'description', 'materials', 'provenance'] as const;
type Field = (typeof FIELDS)[number];

/** Idioma por omision si nada del texto permite decidir. */
const DEFAULT_LOCALE: Locale = 'es';

export interface TranslatedLot {
  sourceLocale: Locale;
  model: string;
  translations: LotTranslation[];
}

/**
 * Traduce la ficha de una obra a los demas idiomas. El idioma de la ficha se
 * detecta en la descripcion, que es el texto mas largo. Cada campo se detecta
 * aparte cuando es lo bastante largo: asi una ficha con el titulo en ingles y
 * la descripcion en espanol (como las del Met) no traduce de nuevo lo que ya
 * esta en el idioma destino, sino que lo copia.
 */
export class TranslateLot {
  constructor(
    private readonly translator: Translator | null,
    private readonly detector: LanguageDetector,
  ) {}

  async execute(texts: LotTexts): Promise<TranslatedLot> {
    if (!this.translator) {
      throw DomainError.precondition('La traduccion automatica esta desactivada');
    }
    const sourceLocale =
      this.detector.detect(texts.description) ?? this.detector.detect(`${texts.title}. ${texts.description}`) ?? DEFAULT_LOCALE;
    const translations: LotTranslation[] = [];
    for (const target of targetLocales(sourceLocale)) {
      translations.push({ locale: target, texts: await this.translateTo(texts, sourceLocale, target, this.translator) });
    }
    return { sourceLocale, model: this.translator.name, translations };
  }

  private localeOf(text: string, fallback: Locale): Locale {
    return text.length >= MIN_DETECTABLE_LENGTH ? (this.detector.detect(text) ?? fallback) : fallback;
  }

  private async translateTo(texts: LotTexts, source: Locale, target: Locale, translator: Translator): Promise<LotTexts> {
    const result: LotTexts = { ...texts };
    // Los campos se agrupan por idioma de origen: una sola llamada al modelo por direccion.
    const pending = new Map<Locale, Array<{ field: Field; chunks: string[]; join: (translated: string[]) => string }>>();
    for (const field of FIELDS) {
      const value = texts[field];
      if (value === null || value.trim() === '') {
        continue;
      }
      const from = this.localeOf(value, source);
      if (from === target) {
        continue;
      }
      // Direcciones, correos y citas viajan como marcadores y vuelven intactos.
      const guarded = protectSegments(value);
      const { chunks, join } = splitForTranslation(guarded.masked);
      const group = pending.get(from) ?? [];
      group.push({ field, chunks, join: (translated) => guarded.restore(join(translated)) ?? value });
      pending.set(from, group);
    }
    for (const [from, group] of pending) {
      const translated = await translator.translate(
        group.flatMap((item) => item.chunks),
        from,
        target,
      );
      let index = 0;
      for (const item of group) {
        result[item.field] = item.join(translated.slice(index, index + item.chunks.length));
        index += item.chunks.length;
      }
    }
    return result;
  }
}
