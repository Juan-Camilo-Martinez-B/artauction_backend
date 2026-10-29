import { DomainError } from '@artauction/platform';
import { auctionClosed, auditFinished, type Notification } from '../domain/notification';

const LIST_LIMIT = 50;

export interface NotificationStore {
  /** Inserta solo los avisos que aun no existen (por id). */
  saveAll(notifications: readonly Notification[]): Promise<void>;
  latest(userId: string, limit: number): Promise<Notification[]>;
  seen(eventId: string): Promise<boolean>;
  recordEvent(eventId: string, eventType: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/**
 * Crea los avisos de cada evento una sola vez. El orden es comprobar, aplicar y
 * registrar: como los avisos tienen id determinista, un fallo entre el efecto y
 * el registro solo repite una escritura idempotente.
 */
export class NotificationEvents {
  constructor(
    private readonly store: NotificationStore,
    private readonly clock: Clock,
  ) {}

  auditCompleted(event: { eventId: string; lotId: string; sellerId: string; verdict: string }): Promise<void> {
    return this.once(event.eventId, 'audit.AuditCompleted', () =>
      this.store.saveAll(auditFinished({ ...event, now: this.clock.now() })),
    );
  }

  auctionClosed(event: { eventId: string; auctionId: string; lotId: string; sellerId: string; winnerId: string | null; amount: string }): Promise<void> {
    return this.once(event.eventId, 'auction.AuctionClosed', () =>
      this.store.saveAll(auctionClosed({ ...event, now: this.clock.now() })),
    );
  }

  private async once(eventId: string, eventType: string, effect: () => Promise<void>): Promise<void> {
    if (!eventId) {
      throw DomainError.invalid('El evento no trae event_id');
    }
    if (await this.store.seen(eventId)) {
      return;
    }
    await effect();
    await this.store.recordEvent(eventId, eventType);
  }
}

/** Los ultimos avisos de quien llama. */
export class ListNotifications {
  constructor(private readonly store: NotificationStore) {}

  execute(userId: string): Promise<Notification[]> {
    return this.store.latest(userId, LIST_LIMIT);
  }
}
