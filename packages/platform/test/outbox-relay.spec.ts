import { StructuredLogger } from '../src/logger/structured-logger';
import type { OutboxMessage, OutboxStore } from '../src/outbox/outbox';
import { OutboxRelay, type OutboxDelivery } from '../src/outbox/outbox-relay';

/** Replica la semantica de PostgresOutboxStore en memoria. */
class MemoryOutbox implements OutboxStore {
  readonly rows: Array<OutboxMessage & { publishedAt: Date | null; availableAt: Date; lastError: string | null }> = [];

  add(seq: number, eventType: string, aggregateId: string): void {
    this.rows.push({
      id: `m${String(seq)}`,
      seq,
      eventType,
      aggregateId,
      payload: { seq },
      occurredAt: new Date(0),
      attempts: 0,
      publishedAt: null,
      availableAt: new Date(0),
      lastError: null,
    });
  }

  claim(limit: number, now: Date, leaseMs: number): Promise<OutboxMessage[]> {
    const pending = this.rows.filter((row) => row.publishedAt === null).sort((a, b) => a.seq - b.seq);
    const claimable = pending.filter(
      (row) =>
        row.availableAt <= now &&
        !pending.some((other) => other.aggregateId === row.aggregateId && other.seq < row.seq),
    );
    const batch = claimable.slice(0, limit);
    for (const row of batch) {
      row.availableAt = new Date(now.getTime() + leaseMs);
    }
    return Promise.resolve(batch.map((row) => ({ ...row })));
  }

  markPublished(id: string, at: Date): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.publishedAt = at;
    }
    return Promise.resolve();
  }

  markFailed(id: string, error: string, retryAt: Date): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.attempts += 1;
      row.lastError = error;
      row.availableAt = retryAt;
    }
    return Promise.resolve();
  }
}

describe('OutboxRelay', () => {
  const logger = new StructuredLogger('test', () => undefined);
  const options = { batchSize: 10, intervalMs: 1_000, leaseMs: 30_000, baseDelayMs: 1_000, maxDelayMs: 60_000 };

  function relay(store: OutboxStore, routes: Record<string, OutboxDelivery[]>, now: () => Date) {
    return new OutboxRelay(store, new Map(Object.entries(routes)), logger, options, now, () => 0);
  }

  it('entrega cada evento a todos sus consumidores y lo marca publicado', async () => {
    const store = new MemoryOutbox();
    store.add(1, 'LotCreated', 'lot-1');
    const seen: string[] = [];
    const published = await relay(
      store,
      {
        LotCreated: [
          (message) => {
            seen.push(`gallery:${message.id}`);
            return Promise.resolve();
          },
          (message) => {
            seen.push(`audit:${message.id}`);
            return Promise.resolve();
          },
        ],
      },
      () => new Date(1_000),
    ).tick();
    expect(published).toBe(1);
    expect(seen).toEqual(['gallery:m1', 'audit:m1']);
    expect(store.rows[0]?.publishedAt).not.toBeNull();
  });

  it('no entrega el siguiente evento del agregado mientras el anterior falla', async () => {
    const store = new MemoryOutbox();
    store.add(1, 'BidAccepted', 'auction-1');
    store.add(2, 'AuctionClosed', 'auction-1');
    store.add(3, 'LotCreated', 'lot-9');
    let now = new Date(1_000);
    let fail = true;
    const order: string[] = [];
    const subject = relay(
      store,
      {
        BidAccepted: [
          () => (fail ? Promise.reject(new Error('wallet caido')) : (order.push('bid'), Promise.resolve())),
        ],
        AuctionClosed: [() => (order.push('closed'), Promise.resolve())],
        LotCreated: [() => (order.push('lot'), Promise.resolve())],
      },
      () => now,
    );
    expect(await subject.tick()).toBe(1);
    expect(order).toEqual(['lot']);
    expect(store.rows[0]?.attempts).toBe(1);
    expect(store.rows[0]?.lastError).toBe('wallet caido');

    fail = false;
    now = new Date(1_500);
    expect(await subject.tick()).toBe(0);

    now = new Date(10_000);
    expect(await subject.tick()).toBe(1);
    expect(await subject.tick()).toBe(1);
    expect(order).toEqual(['lot', 'bid', 'closed']);
  });

  it('marca publicado un evento sin consumidores configurados', async () => {
    const store = new MemoryOutbox();
    store.add(1, 'SinConsumidores', 'x');
    expect(await relay(store, {}, () => new Date(1_000)).tick()).toBe(1);
  });

  it('no se solapa consigo misma', async () => {
    const store = new MemoryOutbox();
    store.add(1, 'LotCreated', 'lot-1');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = relay(store, { LotCreated: [() => gate] }, () => new Date(1_000));
    const first = subject.tick();
    expect(await subject.tick()).toBe(0);
    release();
    expect(await first).toBe(1);
  });
});
