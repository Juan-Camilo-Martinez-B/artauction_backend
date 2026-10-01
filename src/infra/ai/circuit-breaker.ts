export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 30_000,
  ) {}

  assertClosed(now: number): void {
    if (this.openedAt === null) {
      return;
    }
    if (now - this.openedAt < this.cooldownMs) {
      throw new Error('Circuito de auditoría abierto');
    }
    this.openedAt = null;
    this.failures = 0;
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

  get isOpen(): boolean {
    return this.openedAt !== null;
  }
}
