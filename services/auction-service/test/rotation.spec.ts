import type { Auction } from '../src/internal/domain/auction';
import {
  assertRotationPolicy,
  MIN_OPENING_COINS,
  MIN_ROTATION_LEAD_MS,
  rotationDeficit,
  rotationOpeningCoins,
  rotationWindow,
  shuffled,
  type RotationPolicy,
} from '../src/internal/domain/auction-rules';
import type { AuctionCandidate, AuctionPatch, AuctionRepository, CatalogPort, NewAuction, RotationTurn } from '../src/internal/application/ports';
import { RotateCatalogAuctions } from '../src/internal/application/scheduling';

const NOW = new Date('2026-11-02T15:00:00Z');
const clock = { now: () => NOW };
const SELLER = 'a0000000-0000-4000-8000-000000000002';
const POLICY: RotationPolicy = { slots: 3, minMinutes: 15, maxMinutes: 30, maxLeadMs: 300_000, priceFactor: 0.1 };

function candidate(index: number, priceMin = 2000, priceMax = 3000): AuctionCandidate {
  return {
    lotId: `b0000000-0000-4000-8000-00000000000${String(index)}`,
    sellerId: SELLER,
    title: `Obra ${String(index)}`,
    description: 'Óleo sobre lienzo',
    priceMin,
    priceMax,
  };
}

/** Cartelera en memoria: solo lo que la rotacion usa del repositorio. */
class RotationAuctions implements Pick<AuctionRepository, 'countLive' | 'withRotationLock'> {
  created: NewAuction[] = [];
  /** Obras que ya tienen subasta (la restriccion unica de lot_id). */
  taken = new Set<string>();
  liveBefore = 0;
  lockTaken = false;
  countCalls = 0;
  /** Salas ROTATION programadas lejos, listas para adelantar. */
  recyclableRooms: Auction[] = [];
  advanced: Array<{ auctionId: string; patch: AuctionPatch }> = [];

  countLive() {
    this.countCalls += 1;
    return Promise.resolve(this.liveBefore + this.created.length + this.advanced.length);
  }

  async withRotationLock<T>(work: (turn: RotationTurn) => Promise<T>): Promise<T | null> {
    if (this.lockTaken) {
      return null;
    }
    return work({
      countLive: () => this.countLive(),
      createIfAbsent: (auction) => {
        if (this.taken.has(auction.lotId)) {
          return Promise.resolve(null);
        }
        this.taken.add(auction.lotId);
        this.created.push(auction);
        return Promise.resolve({ id: `auction-${auction.lotId}` } as Auction);
      },
      recyclable: (_now, _horizon, limit) => Promise.resolve(this.recyclableRooms.slice(0, limit)),
      update: (auctionId, patch) => {
        this.advanced.push({ auctionId, patch });
        return Promise.resolve();
      },
    });
  }
}

class FakeCatalog implements CatalogPort {
  calls = 0;
  failing = false;
  constructor(private readonly candidates: AuctionCandidate[]) {}

  lot() {
    return Promise.resolve(null);
  }

  auctionCandidates() {
    this.calls += 1;
    return this.failing ? Promise.reject(new Error('catalog caido')) : Promise.resolve(this.candidates);
  }
}

function rotate(auctions: RotationAuctions, catalog: FakeCatalog, policy = POLICY) {
  return new RotateCatalogAuctions(auctions as unknown as AuctionRepository, catalog, clock, policy, () => 0.5);
}

describe('reglas de la rotación', () => {
  it('calcula cuántas salas faltan en la cartelera', () => {
    expect(rotationDeficit(0, 3)).toBe(3);
    expect(rotationDeficit(2, 3)).toBe(1);
    expect(rotationDeficit(5, 3)).toBe(0);
  });

  it('escala el punto medio de la auditoría y respeta la salida mínima', () => {
    expect(rotationOpeningCoins(2000, 3000, 0.1)).toBe(250);
    expect(rotationOpeningCoins(4500, 9000, 0.1)).toBe(675);
    expect(rotationOpeningCoins(100, 200, 0.1)).toBe(MIN_OPENING_COINS);
  });

  it('abre entre un minuto y la espera máxima, y dura entre el mínimo y el máximo', () => {
    const earliest = rotationWindow(NOW, POLICY, () => 0);
    expect(earliest.startsAt.getTime() - NOW.getTime()).toBe(MIN_ROTATION_LEAD_MS);
    expect(earliest.minutes).toBe(15);

    const latest = rotationWindow(NOW, POLICY, () => 1);
    expect(latest.startsAt.getTime() - NOW.getTime()).toBeLessThan(POLICY.maxLeadMs);
    expect(latest.minutes).toBe(30);
    expect(latest.endsAt.getTime() - latest.startsAt.getTime()).toBe(30 * 60_000);
  });

  it('rechaza una política incoherente al arrancar', () => {
    expect(() => assertRotationPolicy({ ...POLICY, minMinutes: 40, maxMinutes: 30 })).toThrow();
    expect(() => assertRotationPolicy({ ...POLICY, priceFactor: 0 })).toThrow();
    expect(() => assertRotationPolicy({ ...POLICY, maxLeadMs: 10_000 })).toThrow();
    expect(assertRotationPolicy(POLICY)).toBe(POLICY);
  });
});

describe('rotación de subastas del catálogo', () => {
  it('llena los lugares libres con obras sin subasta y con salida escalada', async () => {
    const auctions = new RotationAuctions();
    auctions.liveBefore = 1;
    const result = await rotate(auctions, new FakeCatalog([1, 2, 3, 4].map((index) => candidate(index)))).execute();

    expect(result).toEqual({ created: 2, recycled: 0 });
    expect(auctions.created).toHaveLength(2);
    const [first] = auctions.created;
    expect(first?.startPrice).toBe('250.00');
    expect(first?.minIncrement).toBe('13.00');
    expect(first?.sellerId).toBe(SELLER);
    expect(first?.saleDescription).toMatch(/^Obra \d\. Óleo sobre lienzo$/);
    expect(first?.origin).toBe('ROTATION');
    expect(first?.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('salta las obras que ya tienen subasta', async () => {
    const auctions = new RotationAuctions();
    auctions.taken.add(candidate(1).lotId);
    auctions.taken.add(candidate(2).lotId);
    await rotate(auctions, new FakeCatalog([1, 2, 3, 4, 5].map((index) => candidate(index)))).execute();
    expect(auctions.created.map((auction) => auction.lotId).sort()).toEqual([3, 4, 5].map((index) => candidate(index).lotId));
  });

  it('no consulta a catalog si la cartelera está llena', async () => {
    const auctions = new RotationAuctions();
    auctions.liveBefore = 3;
    const catalog = new FakeCatalog([candidate(1)]);
    expect(await rotate(auctions, catalog).execute()).toEqual({ created: 0, recycled: 0 });
    expect(catalog.calls).toBe(0);
  });

  it('no crea nada si otra instancia tiene el turno', async () => {
    const auctions = new RotationAuctions();
    auctions.lockTaken = true;
    expect(await rotate(auctions, new FakeCatalog([candidate(1)])).execute()).toEqual({ created: 0, recycled: 0 });
    expect(auctions.created).toHaveLength(0);
  });

  it('vuelve a contar dentro del turno y no se pasa del cupo', async () => {
    const auctions = new RotationAuctions();
    const policy = { ...POLICY, slots: 1 };
    const catalog = new FakeCatalog([1, 2, 3].map((index) => candidate(index)));
    await rotate(auctions, catalog, policy).execute();
    await rotate(auctions, catalog, policy).execute();
    expect(auctions.created).toHaveLength(1);
  });

  it('adelanta salas rotativas recicladas cuando todo el catálogo ya tiene sala', async () => {
    const auctions = new RotationAuctions();
    auctions.recyclableRooms = [{ id: 'old-1' } as Auction, { id: 'old-2' } as Auction, { id: 'old-3' } as Auction, { id: 'old-4' } as Auction];
    const result = await rotate(auctions, new FakeCatalog([])).execute();

    expect(result).toEqual({ created: 0, recycled: 3 });
    const [first] = auctions.advanced;
    expect(first?.patch.startsAt?.getTime()).toBeGreaterThan(NOW.getTime());
    expect(first?.patch.initialEndsAt).toEqual(first?.patch.endsAt);
    expect(first?.patch.resetExtensions).toBe(true);
    expect(first?.patch.durationMinutes).toBeGreaterThanOrEqual(POLICY.minMinutes);
  });

  it('mezcla obras nuevas y salas recicladas', async () => {
    const auctions = new RotationAuctions();
    auctions.recyclableRooms = [1, 2, 3].map((index) => ({ id: `old-${String(index)}` }) as Auction);
    const policy = { ...POLICY, slots: 6 };
    const result = await rotate(auctions, new FakeCatalog([1, 2, 3].map((index) => candidate(index))), policy).execute();
    expect(result).toEqual({ created: 3, recycled: 3 });
  });

  it('si catalog no responde, recicla igual', async () => {
    const auctions = new RotationAuctions();
    auctions.recyclableRooms = [{ id: 'old-1' } as Auction];
    const catalog = new FakeCatalog([candidate(1)]);
    catalog.failing = true;
    expect(await rotate(auctions, catalog).execute()).toEqual({ created: 0, recycled: 1 });
  });
});

describe('barajado', () => {
  it('conserva los elementos y es reproducible con la misma fuente de azar', () => {
    const items = [1, 2, 3, 4, 5];
    const sequence = () => {
      let seed = 0.37;
      return () => (seed = (seed * 9301 + 0.49297) % 1);
    };
    const once = shuffled(items, sequence());
    expect([...once].sort()).toEqual(items);
    expect(shuffled(items, sequence())).toEqual(once);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});
