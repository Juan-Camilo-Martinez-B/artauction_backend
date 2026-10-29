import { DomainError } from '../errors/domain-error';

/**
 * Circuit breaker de tres estados implicitos: cerrado, abierto y semiabierto.
 * Tras `threshold` fallos seguidos se abre y rechaza llamadas durante
 * `cooldownMs`. Pasado el enfriamiento deja pasar la siguiente llamada; si
 * falla, se vuelve a abrir de inmediato.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly name: string,
    private readonly threshold = 3,
    private readonly cooldownMs = 30_000,
  ) {}

  assertClosed(now: number): void {
    if (this.openedAt === null) {
      return;
    }
    if (now - this.openedAt < this.cooldownMs) {
      throw DomainError.unavailable(`Circuito ${this.name} abierto`);
    }
    this.openedAt = null;
    this.failures = this.threshold - 1;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(now: number): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = now;
    }
  }

  async execute<T>(work: () => Promise<T>, clock: () => number = Date.now): Promise<T> {
    this.assertClosed(clock());
    try {
      const result = await work();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(clock());
      throw error;
    }
  }

  get isOpen(): boolean {
    return this.openedAt !== null;
  }
}
