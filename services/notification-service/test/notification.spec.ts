import { auctionClosed, auditFinished, type Notification } from '../src/internal/domain/notification';
import { ListNotifications, NotificationEvents, type NotificationStore } from '../src/internal/application/use-cases';

const SELLER = 'a0000000-0000-4000-8000-000000000002';
const WINNER = 'a0000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-10-29T12:00:00Z');

class MemoryStore implements NotificationStore {
  notifications = new Map<string, Notification>();
  processed = new Set<string>();
  saveAll(notifications: readonly Notification[]) {
    for (const notification of notifications) {
      if (!this.notifications.has(notification.id)) this.notifications.set(notification.id, notification);
    }
    return Promise.resolve();
  }
  latest(userId: string, limit: number) {
    return Promise.resolve([...this.notifications.values()].filter((item) => item.userId === userId).slice(0, limit));
  }
  seen(eventId: string) {
    return Promise.resolve(this.processed.has(eventId));
  }
  recordEvent(eventId: string) {
    this.processed.add(eventId);
    return Promise.resolve();
  }
}

describe('avisos', () => {
  it('la auditoria avisa solo al vendedor y el cierre al vendedor y al ganador', () => {
    expect(auditFinished({ eventId: 'e1', lotId: 'l1', sellerId: SELLER, verdict: 'APROBADO', now: NOW })).toEqual([
      { id: `e1:${SELLER}`, userId: SELLER, kind: 'AUDIT', payload: { lotId: 'l1', verdict: 'APROBADO' }, createdAt: NOW, readAt: null },
    ]);
    const closed = auctionClosed({ eventId: 'e2', auctionId: 'a1', lotId: 'l1', sellerId: SELLER, winnerId: WINNER, amount: '130.00', now: NOW });
    expect(closed.map((item) => item.userId)).toEqual([SELLER, WINNER]);
    expect(auctionClosed({ eventId: 'e3', auctionId: 'a1', lotId: 'l1', sellerId: SELLER, winnerId: null, amount: '0', now: NOW })).toHaveLength(1);
  });

  it('un evento repetido no duplica avisos, aunque se pierda el registro del inbox', async () => {
    const store = new MemoryStore();
    const events = new NotificationEvents(store, { now: () => NOW });
    const closed = { eventId: 'e2', auctionId: 'a1', lotId: 'l1', sellerId: SELLER, winnerId: WINNER, amount: '130.00' };
    await events.auctionClosed(closed);
    await events.auctionClosed(closed);
    store.processed.clear();
    await events.auctionClosed(closed);
    expect(store.notifications.size).toBe(2);
    expect(await new ListNotifications(store).execute(WINNER)).toEqual([expect.objectContaining({ kind: 'AUCTION_CLOSED' })]);
  });

  it('rechaza un evento sin id', async () => {
    const events = new NotificationEvents(new MemoryStore(), { now: () => NOW });
    await expect(events.auditCompleted({ eventId: '', lotId: 'l1', sellerId: SELLER, verdict: 'APROBADO' })).rejects.toMatchObject({
      kind: 'INVALID_ARGUMENT',
    });
  });
});
