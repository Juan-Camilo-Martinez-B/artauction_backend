import { DomainError } from '@artauction/platform';
import { coinsFromAmount, decideExpiredReservation, holdIncrease, sellerPayout, type WalletSnapshot } from '../src/internal/domain/wallet';
import type {
  BidLookup,
  HoldState,
  LedgerTransaction,
  NewTopUp,
  Reservation,
  ReservationPlan,
  SaleSettlement,
  TopUpRecord,
  WalletRepository,
} from '../src/internal/application/ports';
import { SettleClosedAuction, SweepExpiredReservations, TopUp, TryHold } from '../src/internal/application/use-cases';
import { DECLINED_CARD, luhnOk, SimulatedPaymentGateway } from '../src/internal/infrastructure/simulated-payment-gateway';

const USER = 'a0000000-0000-4000-8000-000000000003';
const CARD = { number: '4242424242424242', name: 'Leo Postor', expMonth: 12, expYear: 2030, cvv: '123' };
const clock = { now: () => new Date('2026-10-28T12:00:00Z') };

class MemoryWallets implements WalletRepository {
  balances = new Map<string, number>();
  orders: Array<TopUpRecord & { idempotencyKey: string }> = [];
  reservations = new Map<string, { previousCoins: number; nextCoins: number; reservedCoins: number; bidderId: string }>();
  holds = new Map<string, number>();
  settled: Array<{ auctionId: string; winnerId: string | null; sale: SaleSettlement | null }> = [];
  resolved: Array<[string, string]> = [];
  expired: Reservation[] = [];
  credits = 0;

  snapshot(): Promise<WalletSnapshot> {
    return Promise.resolve({ balance: 0, held: 0, entries: [] });
  }

  findTopUp(userId: string, key: string) {
    return Promise.resolve(this.orders.find((order) => order.userId === userId && order.idempotencyKey === key) ?? null);
  }

  async recordTopUp(input: NewTopUp) {
    const raced = await this.findTopUp(input.userId, input.idempotencyKey);
    if (raced) {
      return { record: raced, created: false, balance: await this.balance(input.userId) };
    }
    const record = {
      orderId: `order-${String(this.orders.length + 1)}`,
      userId: input.userId,
      coins: input.coins,
      approved: input.approved,
      last4: input.last4,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
    };
    this.orders.push(record);
    if (input.approved) {
      this.credits += 1;
      this.balances.set(input.userId, (this.balances.get(input.userId) ?? 0) + input.coins);
    }
    return { record, created: true, balance: await this.balance(input.userId) };
  }

  balance(userId: string) {
    return Promise.resolve(this.balances.get(userId) ?? 0);
  }

  async reserve(input: { reservationId: string; auctionId: string; bidderId: string }, plan: (state: HoldState) => ReservationPlan) {
    await Promise.resolve();
    const existing = this.reservations.get(input.reservationId);
    if (existing) {
      return { reservedCoins: existing.reservedCoins, balance: this.balances.get(input.bidderId) ?? 0 };
    }
    const pair = `${input.auctionId}:${input.bidderId}`;
    const previous = Math.max(
      this.holds.get(pair) ?? 0,
      ...[...this.reservations.values()].filter((item) => item.bidderId === input.bidderId).map((item) => item.nextCoins),
    );
    const decided = plan({ balance: this.balances.get(input.bidderId) ?? 0, previousCoins: previous, existing: null });
    this.reservations.set(input.reservationId, { ...decided, bidderId: input.bidderId });
    const balance = (this.balances.get(input.bidderId) ?? 0) - decided.reservedCoins;
    this.balances.set(input.bidderId, balance);
    return { reservedCoins: decided.reservedCoins, balance };
  }

  async applyOnce(_eventId: string, _type: string, work: (ledger: LedgerTransaction) => Promise<void>) {
    await work({
      confirmReservation: () => Promise.resolve(true),
      releaseReservation: () => Promise.resolve(true),
      releaseBidderHold: () => Promise.resolve(0),
      settleAuction: (auctionId, winnerId, sale) => {
        this.settled.push({ auctionId, winnerId, sale });
        return Promise.resolve();
      },
    });
    return true;
  }

  expiredReservations() {
    return Promise.resolve(this.expired);
  }

  resolveReservation(reservationId: string, decision: 'CONFIRM' | 'RELEASE') {
    this.resolved.push([reservationId, decision]);
    return Promise.resolve(true);
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

describe('dominio del bolsillo', () => {
  it('retiene solo la diferencia y nunca hacia atras', () => {
    expect(holdIncrease(850, 900)).toBe(50);
    expect(() => holdIncrease(900, 900)).toThrow(/crece/);
  });

  it('convierte pujas a artacoins enteras', () => {
    expect(coinsFromAmount('850.00')).toBe(850);
    expect(coinsFromAmount('850')).toBe(850);
    expect(() => coinsFromAmount('850.50')).toThrow(/no valido/);
  });

  it('cobra la comision redondeando a favor del vendedor', () => {
    expect(sellerPayout(850, 1000)).toEqual({ feeCoins: 85, netCoins: 765 });
    expect(sellerPayout(99, 1000)).toEqual({ feeCoins: 9, netCoins: 90 });
    expect(sellerPayout(100, 0)).toEqual({ feeCoins: 0, netCoins: 100 });
  });

  it('solo libera una reserva vencida cuando auction confirma que no hay puja', () => {
    expect(decideExpiredReservation({ exists: true })).toBe('CONFIRM');
    expect(decideExpiredReservation({ exists: false })).toBe('RELEASE');
    expect(decideExpiredReservation(null)).toBe('RETRY_LATER');
  });
});

describe('pasarela simulada', () => {
  const gateway = new SimulatedPaymentGateway(() => new Date('2026-10-28T12:00:00Z'));
  const charge = (card: Partial<typeof CARD>) =>
    gateway.charge({ card: { ...CARD, ...card }, amountCents: 10_000, idempotencyKey: 'key-0000001' });

  it('aprueba una tarjeta valida y rechaza la de prueba, la caducada y el CVV corto', async () => {
    expect(luhnOk('4242424242424242')).toBe(true);
    await expect(charge({})).resolves.toEqual({ approved: true, brand: 'visa', last4: '4242' });
    expect((await charge({ number: DECLINED_CARD })).approved).toBe(false);
    expect((await charge({ expYear: 2020 })).approved).toBe(false);
    expect((await charge({ cvv: '12' })).approved).toBe(false);
  });
});

describe('recarga idempotente', () => {
  it('no cobra dos veces la misma recarga', async () => {
    const wallets = new MemoryWallets();
    const topUp = new TopUp(wallets, new SimulatedPaymentGateway());
    const first = await topUp.execute(USER, { idempotencyKey: 'topup-key-001', coins: 500, card: CARD });
    const again = await topUp.execute(USER, { idempotencyKey: 'topup-key-001', coins: 500, card: CARD });
    expect(again.orderId).toBe(first.orderId);
    expect(again.balance).toBe(500);
    expect(wallets.credits).toBe(1);
  });

  it('rechaza la misma clave con otro contenido', async () => {
    const wallets = new MemoryWallets();
    const topUp = new TopUp(wallets, new SimulatedPaymentGateway());
    await topUp.execute(USER, { idempotencyKey: 'topup-key-002', coins: 500, card: CARD });
    await expectKind(topUp.execute(USER, { idempotencyKey: 'topup-key-002', coins: 900, card: CARD }), 'CONFLICT');
  });

  it('una tarjeta rechazada sigue rechazada al repetir la clave, sin abonar', async () => {
    const wallets = new MemoryWallets();
    const topUp = new TopUp(wallets, new SimulatedPaymentGateway());
    const declined = { ...CARD, number: DECLINED_CARD };
    await expectKind(topUp.execute(USER, { idempotencyKey: 'topup-key-003', coins: 500, card: declined }), 'INVALID_ARGUMENT');
    await expectKind(topUp.execute(USER, { idempotencyKey: 'topup-key-003', coins: 500, card: declined }), 'INVALID_ARGUMENT');
    expect(wallets.orders).toHaveLength(1);
    expect(await wallets.balance(USER)).toBe(0);
  });

  it('valida la clave y la cantidad antes de cobrar', async () => {
    const topUp = new TopUp(new MemoryWallets(), new SimulatedPaymentGateway());
    await expectKind(topUp.execute(USER, { idempotencyKey: 'corta', coins: 500, card: CARD }), 'INVALID_ARGUMENT');
    await expectKind(topUp.execute(USER, { idempotencyKey: 'topup-key-004', coins: 10, card: CARD }), 'INVALID_ARGUMENT');
  });
});

describe('retencion TCC', () => {
  it('reserva la diferencia, es idempotente y rechaza saldo insuficiente', async () => {
    const wallets = new MemoryWallets();
    wallets.balances.set(USER, 1000);
    const tryHold = new TryHold(wallets, clock);
    const first = await tryHold.execute({ reservationId: 'bid-key-1', auctionId: 'a1', bidderId: USER, nextCoins: 850 });
    expect(first).toEqual({ reservedCoins: 850, balance: 150 });
    const second = await tryHold.execute({ reservationId: 'bid-key-2', auctionId: 'a1', bidderId: USER, nextCoins: 900 });
    expect(second.reservedCoins).toBe(50);
    const repeated = await tryHold.execute({ reservationId: 'bid-key-2', auctionId: 'a1', bidderId: USER, nextCoins: 900 });
    expect(repeated.reservedCoins).toBe(50);
    expect(await wallets.balance(USER)).toBe(100);
    await expectKind(
      tryHold.execute({ reservationId: 'bid-key-3', auctionId: 'a1', bidderId: USER, nextCoins: 1200 }),
      'FAILED_PRECONDITION',
    );
  });
});

describe('liquidacion y barrido', () => {
  it('abona al vendedor el precio menos la comision', async () => {
    const wallets = new MemoryWallets();
    await new SettleClosedAuction(wallets, 1000).execute({
      eventId: 'e1',
      auctionId: 'a1',
      winnerId: USER,
      sellerId: 'seller',
      amount: '850.00',
    });
    expect(wallets.settled[0]?.sale).toEqual({ sellerId: 'seller', grossCoins: 850, feeCoins: 85, netCoins: 765 });
  });

  it('una subasta sin ganador no paga al vendedor', async () => {
    const wallets = new MemoryWallets();
    await new SettleClosedAuction(wallets, 1000).execute({ eventId: 'e2', auctionId: 'a1', winnerId: null, sellerId: 'seller', amount: '0' });
    expect(wallets.settled[0]?.sale).toBeNull();
  });

  it('confirma, libera o espera segun auction', async () => {
    const wallets = new MemoryWallets();
    const reservation = (id: string): Reservation => ({ reservationId: id, auctionId: 'a1', bidderId: USER, reservedCoins: 10, expiresAt: new Date(0) });
    wallets.expired = [reservation('saved'), reservation('lost'), reservation('unknown')];
    const lookup: BidLookup = {
      byReservation: (id) => Promise.resolve(id === 'saved' ? { exists: true } : id === 'lost' ? { exists: false } : null),
    };
    expect(await new SweepExpiredReservations(wallets, lookup, clock).execute()).toBe(2);
    expect(wallets.resolved).toEqual([
      ['saved', 'CONFIRM'],
      ['lost', 'RELEASE'],
    ]);
  });
});
