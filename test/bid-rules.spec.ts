import { centsToMoney, evaluateBid, moneyToCents } from '../src/modules/subastas/bid-rules';

const base = {
  now: new Date('2026-09-30T12:00:00.000Z'),
  auctionStatus: 'ACTIVA',
  lotStatus: 'EN_SUBASTA',
  sellerId: 'seller',
  bidderId: 'bidder',
  currentPriceCents: 10_000,
  minIncrementCents: 1_000,
  hasBids: true,
  endsAt: new Date('2026-09-30T12:10:00.000Z'),
  amountCents: 11_000,
};

describe('reglas de puja', () => {
  it('convierte dinero sin perder centavos', () => {
    expect(moneyToCents('150.00')).toBe(15_000);
    expect(moneyToCents({ toFixed: () => '10.50' })).toBe(1_050);
    expect(centsToMoney(1_050)).toBe('10.50');
  });

  it('exige el incremento y rechaza la puja propia', () => {
    expect(evaluateBid(base).ok).toBe(true);
    expect(evaluateBid({ ...base, amountCents: 10_500 }).ok).toBe(false);
    const own = evaluateBid({ ...base, bidderId: 'seller' });
    expect(own.ok).toBe(false);
    if (!own.ok) {
      expect(own.code).toBe('OWN_LOT');
    }
  });

  it('alarga el cierre en los últimos 30 segundos', () => {
    const decision = evaluateBid({
      ...base,
      hasBids: false,
      amountCents: 10_000,
      endsAt: new Date('2026-09-30T12:00:20.000Z'),
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.extended).toBe(true);
      expect(decision.nextEndsAt.toISOString()).toBe('2026-09-30T12:00:50.000Z');
    }
  });

  it('rechaza una subasta cerrada o inactiva', () => {
    const closed = evaluateBid({ ...base, now: new Date('2026-09-30T12:10:00.000Z') });
    const inactive = evaluateBid({ ...base, auctionStatus: 'PROGRAMADA' });
    expect(closed.ok).toBe(false);
    expect(inactive.ok).toBe(false);
  });
});
