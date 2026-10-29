import { CircuitBreaker, DomainError, retry } from '@artauction/platform';
import type { JsonGenerationRequest, LanguageModel } from '../application/ports';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Error HTTP de Gemini; solo 429 y 5xx valen un reintento. */
class GeminiHttpError extends Error {
  constructor(readonly status: number) {
    super(`Gemini respondio ${String(status)}`);
  }
}

function retryable(error: unknown): boolean {
  if (error instanceof GeminiHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // Timeout o corte de red.
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'TypeError');
}

/**
 * Gemini por REST (generateContent). Gemini no ofrece gRPC publico estable,
 * por eso es la unica llamada REST del sistema (ADR 0002).
 *
 * Para acotar el gasto: salida JSON con esquema (responseJsonSchema), tope de
 * tokens de salida y razonamiento al minimo. Los modelos 2.x usan
 * thinkingBudget = 0 y los 3.x en adelante thinkingLevel = "minimal"; enviar
 * ambos campos da 400, asi que se elige uno segun el modelo.
 */
export class GeminiModel implements LanguageModel {
  readonly name: string;
  private readonly breaker = new CircuitBreaker('gemini', 3, 30_000);
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: GeminiOptions) {
    this.name = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async generateJson(request: JsonGenerationRequest): Promise<unknown> {
    this.breaker.assertClosed(Date.now());
    try {
      const text = await retry(() => this.call(request), {
        attempts: 3,
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
      throw DomainError.unavailable(error instanceof Error ? error.message : 'Gemini no respondio');
    }
  }

  private async call(request: JsonGenerationRequest): Promise<string> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.options.model)}:generateContent`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      // La clave va en cabecera, nunca en la URL, para que no quede en logs de proxies.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey },
      signal: AbortSignal.timeout(this.options.timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: request.schema,
          thinkingConfig: thinkingConfigFor(this.options.model),
        },
      }),
    });
    if (!response.ok) {
      throw new GeminiHttpError(response.status);
    }
    return readText(await response.json());
  }
}

export function thinkingConfigFor(model: string): Record<string, unknown> {
  const major = /^gemini-(\d+)/.exec(model)?.[1];
  return major !== undefined && Number(major) <= 2 ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

export function readText(payload: unknown): string {
  const candidates = field(payload, 'candidates');
  const first: unknown = Array.isArray(candidates) ? candidates[0] : undefined;
  const parts = field(field(first, 'content'), 'parts');
  const texts = Array.isArray(parts) ? parts.map((part) => field(part, 'text')).filter((text): text is string => typeof text === 'string') : [];
  if (texts.length === 0) {
    throw new Error('Gemini no devolvio texto');
  }
  return texts.join('');
}
