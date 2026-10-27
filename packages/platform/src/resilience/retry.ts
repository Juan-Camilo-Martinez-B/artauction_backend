export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Reintenta una operacion con backoff exponencial y jitter completo
 * (delay = random * min(max, base * 2^intento)). Solo debe envolver
 * operaciones idempotentes.
 */
export async function retry<T>(work: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const retryable = options.shouldRetry?.(error) ?? true;
      if (!retryable || attempt === options.attempts - 1) {
        break;
      }
      await sleep(backoffDelay(attempt, options, random));
    }
  }
  throw lastError;
}

export function backoffDelay(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
