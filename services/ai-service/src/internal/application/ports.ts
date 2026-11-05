import type { Locale } from '../domain/translation';

/** Peticion a un modelo generativo que debe responder JSON con un esquema dado. */
export interface JsonGenerationRequest {
  /** Instrucciones del sistema; nunca incluyen texto del usuario. */
  system: string;
  /** Datos a analizar, ya serializados. Se tratan como datos, no como ordenes. */
  user: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
}

/** Modelo generativo detras de una API externa (hoy Groq). */
export interface LanguageModel {
  readonly name: string;
  generateJson(request: JsonGenerationRequest): Promise<unknown>;
}

/** Traduce textos entre dos idiomas, en el mismo orden en que llegan. */
export interface Translator {
  readonly name: string;
  translate(texts: string[], from: Locale, to: Locale): Promise<string[]>;
}

/** Idioma de un texto, o null si no se puede decir con confianza. */
export interface LanguageDetector {
  detect(text: string): Locale | null;
}
