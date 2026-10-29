import { DomainError, type DomainEvent } from '@artauction/platform';
import { AUCTION_EVENTS, type Auction, type Bid } from '../src/internal/domain/auction';
import { canWithdraw, durationMinutes, evaluateBid } from '../src/internal/domain/auction-rules';
import { toCents } from '../src/internal/domain/money';
import { PlaceBid, WithdrawBid } from '../src/internal/application/bidding';
import type { AuctionPatch, AuctionRepository, AuctionUnitOfWork, LiveNotice } from '../src/internal/application/ports';
import { RunScheduler } from '../src/internal/application/scheduling';

const NOW = new Date('2026-10-28T15:00:00Z');
const SELLER = 'a0000000-0000-4000-8000-000000000002';
const LEO = 'a0000000-0000-4000-8000-000000000003';
const NORA = 'a0000000-0000-4000-8000-000000000004';
const AUCTION_ID = 'c0000000-0000-4000-8000-000000000002';
const clock = { now: () => NOW };

function activeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    id: AUCTION_ID,
    lotId: 'b0000000-0000-4000-8000-000000000001',
    sellerId: SELLER,
    lotTitle: 'Retrato de la costa',
    startPrice: '800.00',
    currentPrice: '800.00',
    minIncrement: '50.00',
    currency: 'ATC',
    startsAt: new Date(NOW.getTime() - 60_000),
    endsAt: new Date(NOW.getTime() + 3_600_000),
    initialEndsAt: new Date(NOW.getTime() + 3_600_000),
    status: 'ACTIVA',
    winnerId: null,
    extensionCount: 0,
    durationMinutes: 60,
    saleDescription: null,
    ...overrides,
  };
}

/** Repositorio en memoria con la misma semantica transaccional del real. */
class MemoryAuctions implements AuctionRepository {
  auction: Auction;
  bids: Array<Bid & { idempotencyKey: string }> = [];
  outbox: DomainEvent[] = [];
  sales: unknown[] = [];
  log: string[] = [];
  private seq = 0;

  constructor(auction: Auction) {
    this.auction = auction;
  }

  private uow(): AuctionUnitOfWork {
    return {
      lock: () => {
        this.log.push('lock');
        return Promise.resolve({ ...this.auction });
      },
      bidByKey: (key) => Promise.resolve(this.bids.find((bid) => bid.idempotencyKey === key) ?? null),
      activeBidCount: () => Promise.resolve(this.bids.filter((bid) => bid.active).length),
      activeBidderAt: (_id, amount) =>
        Promise.resolve(this.bids.find((bid) => bid.active && toCents(bid.amount) === toCents(amount))?.bidderId ?? null),
      topActiveBid: () =>
        Promise.resolve([...this.bids].filter((bid) => bid.active).sort((a, b) => toCents(b.amount) - toCents(a.amount))[0] ?? null),
      bidderActiveBid: (_id, bidderId) => Promise.resolve(this.bids.find((bid) => bid.active && bid.bidderId === bidderId) ?? null),
      insertBid: (bid) => {
        this.seq += 1;
        const created = { id: `bid-${String(this.seq)}`, active: true, createdAt: NOW, ...bid };
        this.bids.push(created);
        return Promise.resolve(created);
      },
      deactivateBids: (_id, bidderId) => {
        for (const bid of this.bids) {
          if (bidderId === undefined || bid.bidderId === bidderId) {
            bid.active = false;
          }
        }
        return Promise.resolve();
      },
      allowPriceRewind: () => Promise.resolve(),
      update: (_id, patch: AuctionPatch) => {
        const { extensionCountIncrement, resetExtensions, ...rest } = patch;
        this.auction = {
          ...this.auction,
          ...rest,
          extensionCount: resetExtensions === true ? 0 : this.auction.extensionCount + (extensionCountIncrement === true ? 1 : 0),
        };
        return Promise.resolve();
      },
      recordSale: (sale) => {
        this.sales.push(sale);
        return Promise.resolve();
      },
      createIfAbsent: () => Promise.resolve(null),
      emit: (events) => {
        this.outbox.push(...events);
        return Promise.resolve();
      },
    };
  }

  async transaction<T>(work: (uow: AuctionUnitOfWork) => Promise<T>): Promise<T> {
    const snapshot = { auction: { ...this.auction }, bids: this.bids.map((bid) => ({ ...bid })), outbox: [...this.outbox] };
    try {
      return await work(this.uow());
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  applyOnce<T>(_eventId: string, _type: string, work: (uow: AuctionUnitOfWork) => Promise<T>) {
    return this.transaction(work);
  }

  findById() {
    return Promise.resolve({ ...this.auction });
  }

  findByLotId() {
    return Promise.resolve({ ...this.auction });
  }

  findByLotIds() {
    return Promise.resolve([{ ...this.auction }]);
  }

  recentBids() {
    return Promise.resolve(this.bids);
  }

  bidByKey(key: string) {
    return Promise.resolve(this.bids.find((bid) => bid.idempotencyKey === key) ?? null);
  }

  create() {
    return Promise.resolve(null);
  }

  dueToOpen() {
    return Promise.resolve(this.auction.status === 'PROGRAMADA' ? [this.auction.id] : []);
  }

  dueToClose() {
    return Promise.resolve(this.auction.status === 'ACTIVA' ? [this.auction.id] : []);
  }
}

class RecordingWallet {
  readonly calls: Array<{ reservationId: string; nextCoins: number }> = [];

  constructor(
    private readonly repo: MemoryAuctions,
    private readonly fail = false,
  ) {}

  tryHold(input: { reservationId: string; nextCoins: number }) {
    this.repo.log.push('tryHold');
    this.calls.push(input);
    return this.fail
      ? Promise.reject(DomainError.invalid('No tienes artacoins suficientes. Faltan 100 en el bolsillo.'))
      : Promise.resolve({ reservedCoins: input.nextCoins });
  }
}

class RecordingLive {
  readonly notices: LiveNotice[] = [];

  publish(notice: LiveNotice) {
    this.notices.push(notice);
  }
}

async function expectKind(promise: Promise<unknown>, kind: DomainError['kind']): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).kind).toBe(kind);
}

function setup(auction = activeAuction(), walletFails = false) {
  const repo = new MemoryAuctions(auction);
  const wallet = new RecordingWallet(repo, walletFails);
  const live = new RecordingLive();
  return { repo, wallet, live, placeBid: new PlaceBid(repo, wallet, live, clock), withdraw: new WithdrawBid(repo, clock) };
}

describe('reglas de la sala', () => {
  const base = {
    now: NOW,
    status: 'ACTIVA' as const,
    sellerId: SELLER,
    bidderId: LEO,
    currentPriceCents: 80_000,
    minIncrementCents: 5_000,
    endsAt: new Date(NOW.getTime() + 3_600_000),
  };

  it('acepta el precio de salida si no hay pujas y exige el incremento despues', () => {
    expect(evaluateBid({ ...base, hasBids: false, amountCents: 80_000 }).ok).toBe(true);
    expect(evaluateBid({ ...base, hasBids: true, amountCents: 80_000 })).toEqual({ ok: false, code: 'TOO_LOW' });
    expect(evaluateBid({ ...base, hasBids: true, amountCents: 85_000 }).ok).toBe(true);
  });

  it('extiende 30 s una puja en los ultimos 30 s', () => {
    const decision = evaluateBid({ ...base, hasBids: false, amountCents: 80_000, endsAt: new Date(NOW.getTime() + 10_000) });
    expect(decision).toEqual({ ok: true, extended: true, nextEndsAt: new Date(NOW.getTime() + 40_000) });
  });

  it('rechaza la obra propia, la sala cerrada y la no activa', () => {
    expect(evaluateBid({ ...base, bidderId: SELLER, hasBids: false, amountCents: 80_000 })).toEqual({ ok: false, code: 'OWN_LOT' });
    expect(evaluateBid({ ...base, endsAt: NOW, hasBids: false, amountCents: 80_000 })).toEqual({ ok: false, code: 'CLOSED' });
    expect(evaluateBid({ ...base, status: 'PROGRAMADA', hasBids: false, amountCents: 80_000 })).toEqual({ ok: false, code: 'NOT_ACTIVE' });
  });

  it('no deja retirarse en los ultimos 4 minutos y escala la duracion con el score', () => {
    expect(canWithdraw(NOW, new Date(NOW.getTime() + 5 * 60_000))).toBe(true);
    expect(canWithdraw(NOW, new Date(NOW.getTime() + 3 * 60_000))).toBe(false);
    expect(durationMinutes(40)).toBe(30);
    expect(durationMinutes(100)).toBe(180);
  });
});

describe('puja con TCC', () => {
  it('reserva en wallet antes de abrir la transaccion y emite BidAccepted con la reserva', async () => {
    const { repo, wallet, live, placeBid } = setup();
    const placed = await placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0001' });
    expect(repo.log).toEqual(['tryHold', 'lock']);
    expect(wallet.calls).toEqual([expect.objectContaining({ reservationId: 'bid-key-0001', nextCoins: 800 })]);
    expect(placed).toMatchObject({ amount: '800.00', currentPrice: '800.00', idempotent: false });
    expect(repo.outbox[0]).toMatchObject({
      type: AUCTION_EVENTS.bidAccepted,
      payload: { reservationId: 'bid-key-0001', heldCoins: 800, bidderId: LEO },
    });
    expect(live.notices).toHaveLength(1);
  });

  it('repetir la clave no reserva otra vez ni emite otro evento', async () => {
    const { repo, wallet, live, placeBid } = setup();
    await placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0001' });
    const again = await placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0001' });
    expect(again.idempotent).toBe(true);
    expect(wallet.calls).toHaveLength(1);
    expect(repo.outbox).toHaveLength(1);
    expect(live.notices).toHaveLength(1);
    await expectKind(placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '850', idempotencyKey: 'bid-key-0001' }), 'CONFLICT');
  });

  it('una puja que de seguro no vale no toca el bolsillo', async () => {
    const { wallet, placeBid } = setup();
    await expectKind(placeBid.execute(SELLER, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0002' }), 'PERMISSION_DENIED');
    await expectKind(placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '799', idempotencyKey: 'bid-key-0003' }), 'INVALID_ARGUMENT');
    await expectKind(placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '850.50', idempotencyKey: 'bid-key-0004' }), 'INVALID_ARGUMENT');
    expect(wallet.calls).toHaveLength(0);
  });

  it('sin saldo la puja no se guarda', async () => {
    const { repo, placeBid } = setup(activeAuction(), true);
    await expectKind(placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0005' }), 'INVALID_ARGUMENT');
    expect(repo.bids).toHaveLength(0);
    expect(repo.outbox).toHaveLength(0);
  });

  it('dos postores no publican el mismo importe y la segunda exige el incremento', async () => {
    const { placeBid } = setup();
    await placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0006' });
    await expectKind(placeBid.execute(NORA, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0007' }), 'INVALID_ARGUMENT');
    const second = await placeBid.execute(NORA, { auctionId: AUCTION_ID, amount: '850', idempotencyKey: 'bid-key-0008' });
    expect(second.currentPrice).toBe('850.00');
  });

  it('el retiro del lider devuelve el precio a la siguiente oferta', async () => {
    const { repo, placeBid, withdraw } = setup();
    await placeBid.execute(LEO, { auctionId: AUCTION_ID, amount: '800', idempotencyKey: 'bid-key-0009' });
    await placeBid.execute(NORA, { auctionId: AUCTION_ID, amount: '850', idempotencyKey: 'bid-key-0010' });
    const result = await withdraw.execute(NORA, AUCTION_ID);
    expect(result).toEqual({ auctionId: AUCTION_ID, released: 850, currentPrice: '800.00' });
    expect(repo.outbox.at(-1)).toMatchObject({ type: AUCTION_EVENTS.bidWithdrawn, payload: { bidderId: NORA } });
  });
});

describe('planificador', () => {
  it('cierra con ganador, registra la venta y avisa a la sala', async () => {
    const repo = new MemoryAuctions(activeAuction({ endsAt: new Date(NOW.getTime() - 1) }));
    repo.bids.push({ id: 'b1', auctionId: AUCTION_ID, bidderId: LEO, amount: '900.00', active: true, createdAt: NOW, idempotencyKey: 'k1' });
    const live = new RecordingLive();
    expect(await new RunScheduler(repo, live, clock).execute()).toEqual({ opened: 0, closed: 1, rescheduled: 0 });
    expect(repo.auction).toMatchObject({ status: 'CERRADA', winnerId: LEO, currentPrice: '900.00' });
    expect(repo.sales).toHaveLength(1);
    expect(repo.outbox[0]).toMatchObject({ type: AUCTION_EVENTS.closed, payload: { winnerId: LEO, sellerId: SELLER, amount: '900.00' } });
    expect(live.notices[0]).toMatchObject({ kind: 'auction-closed', winnerId: LEO });
  });

  it('reprograma una sala vacia al precio de salida', async () => {
    const repo = new MemoryAuctions(activeAuction({ endsAt: new Date(NOW.getTime() - 1), currentPrice: '800.00' }));
    expect(await new RunScheduler(repo, new RecordingLive(), clock, () => 0).execute()).toEqual({ opened: 0, closed: 0, rescheduled: 1 });
    expect(repo.auction.status).toBe('PROGRAMADA');
    expect(repo.auction.startsAt.getTime()).toBe(NOW.getTime() + 15 * 60_000);
    expect(repo.outbox[0]?.type).toBe(AUCTION_EVENTS.rescheduled);
  });

  it('abre una subasta programada y emite AuctionStarted', async () => {
    const repo = new MemoryAuctions(activeAuction({ status: 'PROGRAMADA', startsAt: new Date(NOW.getTime() - 1) }));
    expect((await new RunScheduler(repo, new RecordingLive(), clock).execute()).opened).toBe(1);
    expect(repo.auction.status).toBe('ACTIVA');
    expect(repo.outbox[0]?.type).toBe(AUCTION_EVENTS.started);
  });
});
