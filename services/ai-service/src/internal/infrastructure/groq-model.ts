import { CircuitBreaker, DomainError, retry } from '@artauction/platform';
import type { JsonGenerationRequest, LanguageModel } from '../application/ports';

/** Tokens que consumio una llamada, segun el campo usage de la respuesta. */
export interface TokenUsage {
  model: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GroqOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Se llama tras cada respuesta correcta, para registrar el gasto de tokens. */
  onUsage?: (usage: TokenUsage) => void;
}

/** Error HTTP de Groq, con el codigo para decidir si vale reintentar. */
export class GroqHttpError extends Error {
  constructor(readonly status: number) {
    super(`Groq respondio ${String(status)}`);
  }
}

/**
 * Los modelos gpt-oss razonan antes de responder y ese razonamiento sale del
 * mismo tope de tokens. Con esfuerzo bajo basta un margen fijo sobre la
 * salida que pide el caso de uso; si aun asi se agota, la respuesta llega
 * cortada (finish_reason = length) y se trata como fallo.
 */
const REASONING_ALLOWANCE_TOKENS = 1_024;

/**
 * Limites que el modo estricto de Groq no documenta como soportados. Se
 * quitan del esquema que va al modelo: los rangos los vuelve a comprobar
 * quien recibe la respuesta (sanitizeAssessment en la auditoria,
 * validateGalleryConfig en la galeria), que es la validacion que decide.
 */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set(['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern']);

/**
 * Solo un 5xx, un timeout o un corte de red valen el unico reintento. Un 429
 * es cuota agotada: reintentar solo gasta tiempo, y quien llama tiene su
 * propio respaldo (la evaluacion local en la auditoria, el diseno local en la
 * galeria). Un 4xx distinto es un error de la peticion y no cambia al repetirla.
 */
export function retryable(error: unknown): boolean {
  if (error instanceof GroqHttpError) {
    return error.status >= 500;
  }
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'TypeError');
}

/**
 * Pasa un JSON Schema a la forma que exige el modo estricto de Groq: cada
 * objeto cierra sus propiedades (additionalProperties = false) y las declara
 * todas en required; ademas se quitan las palabras clave no documentadas.
 * No modifica el esquema recibido.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(strictSchema);
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      continue;
    }
    // En "properties" las claves son nombres de campos, no palabras clave: no se filtran.
    result[key] =
      key === 'properties' && typeof value === 'object' && value !== null
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, property]) => [name, strictSchema(property)]))
        : strictSchema(value);
  }
  if (result['type'] === 'object') {
    const properties = (result['properties'] ?? {}) as Record<string, unknown>;
    result['properties'] = properties;
    result['required'] = Object.keys(properties);
    result['additionalProperties'] = false;
  }
  return result;
}

/**
 * Groq por su API compatible con OpenAI (chat/completions), con fetch y sin
 * dependencias. Groq no ofrece gRPC publico, por eso es la unica llamada REST
 * del sistema (ADR 0002 y ADR 0011).
 *
 * Para acotar el gasto y asegurar el formato: salida JSON con esquema en modo
 * estricto (constrained decoding, solo en los modelos gpt-oss y algunos mas),
 * tope de tokens, razonamiento en esfuerzo bajo y sin devolverlo.
 */
export class GroqModel implements LanguageModel {
  readonly name: string;
  private readonly breaker = new CircuitBreaker('groq', 3, 30_000);
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: GroqOptions) {
    this.name = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.groq.com/openai/v1';
  }

  async generateJson(request: JsonGenerationRequest): Promise<unknown> {
    this.breaker.assertClosed(Date.now());
    try {
      const text = await retry(() => this.call(request), {
        attempts: 2,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        shouldRetry: retryable,
      });
      this.breaker.recordSuccess();
      return JSON.parse(text) as unknown;
    } catch (error) {
      this.breaker.recordFailure(Date.now());
      if (error instanceof DomainError) {
        throw error;
      }
      throw DomainError.unavailable(error instanceof Error ? error.message : 'Groq no respondio');
    }
  }

  private async call(request: JsonGenerationRequest): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      // La clave va en cabecera, nunca en la URL, para que no quede en logs de proxies.
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      signal: AbortSignal.timeout(this.options.timeoutMs),
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        temperature: request.temperature,
        max_completion_tokens: request.maxOutputTokens + REASONING_ALLOWANCE_TOKENS,
        reasoning_effort: 'low',
        include_reasoning: false,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'respuesta', strict: true, schema: strictSchema(request.schema) },
        },
      }),
    });
    if (!response.ok) {
      throw new GroqHttpError(response.status);
    }
    const payload: unknown = await response.json();
    const usage = readUsage(payload, this.options.model);
    if (usage) {
      this.options.onUsage?.(usage);
    }
    return readContent(payload);
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

export function readUsage(payload: unknown, model: string): TokenUsage | null {
  const usage = field(payload, 'usage');
  if (usage === undefined) {
    return null;
  }
  const count = (key: string) => {
    const value = field(usage, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return { model, promptTokens: count('prompt_tokens'), outputTokens: count('completion_tokens'), totalTokens: count('total_tokens') };
}

/** Texto JSON de la primera opcion. Una respuesta cortada o vacia es un fallo. */
export function readContent(payload: unknown): string {
  const choices = field(payload, 'choices');
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (field(first, 'finish_reason') === 'length') {
    throw new Error('Groq corto la respuesta por el tope de tokens');
  }
  const content = field(field(first, 'message'), 'content');
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Groq no devolvio texto');
  }
  return content;
}
