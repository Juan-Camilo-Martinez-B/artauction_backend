import type { StructuredLogger } from '../logger/structured-logger';
import { backoffDelay } from '../resilience/retry';
import type { OutboxMessage, OutboxStore } from './outbox';

/** Entrega un mensaje a un consumidor. Debe rechazar si la entrega fallo. */
export type OutboxDelivery = (message: OutboxMessage) => Promise<void>;

export interface OutboxRelayOptions {
  batchSize: number;
  intervalMs: number;
  leaseMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RELAY_OPTIONS: OutboxRelayOptions = {
  batchSize: 50,
  intervalMs: 500,
  leaseMs: 30_000,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
};

/**
 * Lee el outbox en orden y entrega cada evento a todos sus consumidores. Si una
 * entrega falla, el mensaje se reintenta con backoff y los mensajes posteriores
 * de su agregado esperan (el store no los reclama), para no romper el orden.
 * Un evento sin consumidores configurados se marca publicado. La entrega es "al menos una vez";
 * los consumidores la vuelven idempotente con su inbox.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly routes: ReadonlyMap<string, readonly OutboxDelivery[]>,
    private readonly logger: StructuredLogger,
    private readonly options: OutboxRelayOptions = DEFAULT_RELAY_OPTIONS,
    private readonly clock: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Una pasada. Devuelve cuantos mensajes se publicaron. No se solapa consigo misma. */
  async tick(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      return await this.drain();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error), undefined, 'outbox');
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<number> {
    // claim solo devuelve el primer pendiente de cada agregado, asi que dentro
    // de un lote no hay dos mensajes del mismo agregado.
    const messages = await this.store.claim(this.options.batchSize, this.clock(), this.options.leaseMs);
    let published = 0;
    for (const message of messages) {
      const deliveries = this.routes.get(message.eventType) ?? [];
      try {
        for (const deliver of deliveries) {
          await deliver(message);
        }
        await this.store.markPublished(message.id, this.clock());
        published += 1;
      } catch (error) {
        const delay = backoffDelay(message.attempts, this.options, this.random) + this.options.baseDelayMs;
        const reason = error instanceof Error ? error.message : String(error);
        await this.store.markFailed(message.id, reason, new Date(this.clock().getTime() + delay));
        this.logger.warn(`entrega de ${message.eventType} fallo (intento ${String(message.attempts + 1)}): ${reason}`, 'outbox');
      }
    }
    return published;
  }
}
