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

/** Modelo generativo detras de una API externa (Gemini u otro proveedor). */
export interface LanguageModel {
  readonly name: string;
  generateJson(request: JsonGenerationRequest): Promise<unknown>;
}
