import { detect } from 'tinyld';
import type { LanguageDetector } from '../application/ports';
import { isLocale, LOCALES, type Locale } from '../domain/translation';

/**
 * Detector de idioma local (tinyld), limitado a los idiomas de la plataforma.
 * Acierta bien desde unas dos docenas de caracteres; en textos mas cortos
 * quien llama decide con el idioma del resto de la ficha.
 */
export class TinyLdDetector implements LanguageDetector {
  detect(text: string): Locale | null {
    const code = detect(text, { only: [...LOCALES] });
    return isLocale(code) ? code : null;
  }
}
