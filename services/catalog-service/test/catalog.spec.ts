import { DomainError, type DomainEvent } from '@artauction/platform';
import { CATALOG_EVENTS } from '../src/internal/domain/events';
import { canViewLot, imageUrl, parseNewLot, type Actor, type Category, type Lot, type LotImage, type NewLot } from '../src/internal/domain/lot';
import { canTransition, type LotStatus } from '../src/internal/domain/lot-status';
import type { LotPatch, LotRepository, LotTransitions, PublicLotQuery, SimilarImage } from '../src/internal/application/ports';
import { CreateLot, RegisterLotImage, ResolveManualReview, SignImageUpload, SubmitLot } from '../src/internal/application/commands';
import { MarkLotSold } from '../src/internal/application/event-handlers';
import { FindSimilarImages, GetLotForViewer, ListPublicLots, ListReviewQueue } from '../src/internal/application/queries';

const SELLER: Actor = { userId: 'a0000000-0000-4000-8000-000000000002', role: 'SELLER' };
const OTHER: Actor = { userId: 'a0000000-0000-4000-8000-000000000003', role: 'SELLER' };
const ADMIN: Actor = { userId: 'a0000000-0000-4000-8000-000000000001', role: 'ADMIN' };
const BUYER: Actor = { userId: 'a0000000-0000-4000-8000-000000000004', role: 'USER' };
const PAINTINGS: Category = { id: 'cat-1', name: 'Pinturas', slug: 'pinturas', description: 'Obra plana', active: true };

class MemoryLots implements LotRepository {
  readonly lots = new Map<string, Lot>();
  readonly outbox: DomainEvent[] = [];
  readonly inbox = new Set<string>();
  readonly lastQuery: PublicLotQuery[] = [];
  private seq = 0;

  listPublic(query: PublicLotQuery) {
    this.lastQuery.push(query);
    return Promise.resolve({ lots: [], total: 0 });
  }

  relatedPublic() {
    return Promise.resolve([]);
  }

  findById(lotId: string) {
    return Promise.resolve(this.lots.get(lotId) ?? null);
  }

  findByIds(lotIds: readonly string[]) {
    return Promise.resolve(lotIds.flatMap((id) => this.lots.get(id) ?? []));
  }

  findActiveCategory(slug: string) {
    return Promise.resolve(slug === PAINTINGS.slug ? PAINTINGS : null);
  }

  listActiveCategories() {
    return Promise.resolve([PAINTINGS]);
  }

  listByStatus(status: LotStatus, limit: number) {
    return Promise.resolve([...this.lots.values()].filter((lot) => lot.status === status).slice(0, limit));
  }

  findSimilarImages(lotId: string, hashes: readonly string[], maxDistance: number) {
    const matches: SimilarImage[] = [];
    for (const lot of this.lots.values()) {
      for (const image of lot.id === lotId ? [] : lot.images) {
        for (const hash of hashes) {
          const distance = image.perceptualHash === null ? Infinity : hamming(hash, image.perceptualHash);
          if (distance <= maxDistance && image.perceptualHash !== null) {
            matches.push({ lotId: lot.id, sellerId: lot.sellerId, queryHash: hash, matchedHash: image.perceptualHash, distance });
          }
        }
      }
    }
    return Promise.resolve(matches);
  }

  create(sellerId: string, lot: NewLot, _categoryId: string, events: (lot: Lot) => DomainEvent[]) {
    this.seq += 1;
    const created: Lot = {
      id: `b0000000-0000-4000-8000-00000000000${String(this.seq)}`,
      sellerId,
      title: lot.title,
      description: lot.description,
      artistName: lot.artistName,
      creationYear: lot.creationYear,
      materials: lot.materials,
      widthCm: lot.widthCm,
      heightCm: lot.heightCm,
      depthCm: lot.depthCm,
      provenance: lot.provenance,
      representationKind: lot.representationKind,
      status: 'BORRADOR',
      visibility: 'PRIVATE',
      authenticityScore: null,
      suggestedPriceMin: null,
      suggestedPriceMax: null,
      currency: 'USD',
      createdAt: new Date(0),
      images: [],
      categories: [{ isPrimary: true, category: PAINTINGS }],
    };
    this.lots.set(created.id, created);
    this.outbox.push(...events(created));
    return Promise.resolve(created);
  }

  upsertImage(lotId: string, image: { objectKey: string; position: number; perceptualHash: string | null }): Promise<LotImage> {
    return Promise.resolve({ id: `${lotId}-img`, createdAt: new Date(0), ...image });
  }

  transition(lotId: string, from: LotStatus, to: LotStatus, patch: LotPatch, events: (lot: Lot) => DomainEvent[]) {
    const lot = this.lots.get(lotId);
    if (!lot || lot.status !== from) {
      return Promise.resolve(null);
    }
    const next = { ...lot, ...patch, status: to };
    this.lots.set(lotId, next);
    this.outbox.push(...events(next));
    return Promise.resolve(next);
  }

  async applyOnce(eventId: string, _type: string, apply: (lots: LotTransitions) => Promise<void>) {
    if (this.inbox.has(eventId)) {
      return false;
    }
    this.inbox.add(eventId);
    await apply({
      findById: (id) => this.findById(id),
      update: (id, from, to, patch) => {
        const lot = this.lots.get(id);
        if (!lot || !from.includes(lot.status)) {
          return Promise.resolve(false);
        }
        this.lots.set(id, { ...lot, ...patch, status: to });
        return Promise.resolve(true);
      },
    });
    return true;
  }
}

const NEW_LOT = {
  title: 'Retrato de la costa',
  description: 'Oleo sobre lienzo con la costa al atardecer.',
  materials: 'Oleo sobre lienzo',
  categorySlug: 'pinturas',
  representationKind: 'TWO_D' as const,
  widthCm: '40',
  heightCm: '50.5',
};

async function expectKind(promise: Promise<unknown>, kind: DomainError['kind']): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).kind).toBe(kind);
}

function hamming(left: string, right: string): number {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (bits > 0n) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
}

describe('dominio del lote', () => {
  it('sigue la maquina de estados', () => {
    expect(canTransition('BORRADOR', 'PENDIENTE_AUDITORIA')).toBe(true);
    expect(canTransition('EN_SUBASTA', 'PUBLICADA')).toBe(true);
    expect(canTransition('BORRADOR', 'EN_SUBASTA')).toBe(false);
    expect(canTransition('VENDIDA', 'PUBLICADA')).toBe(false);
    expect(canTransition('RARO', 'APROBADO')).toBe(false);
  });

  it('valida medidas y exige profundidad a un objeto tridimensional', () => {
    expect(parseNewLot(NEW_LOT).heightCm).toBe('50.5');
    expect(() => parseNewLot({ ...NEW_LOT, widthCm: '0.01' })).toThrow(/ancho/);
    expect(() => parseNewLot({ ...NEW_LOT, representationKind: 'THREE_D' })).toThrow(/profundidad/);
    expect(() => parseNewLot({ ...NEW_LOT, title: 'ab' })).toThrow(/titulo/);
  });

  it('resuelve URLs de imagen sin publicar claves ajenas', () => {
    const base = 'http://artauction-media.web.garage.localhost:3902';
    expect(imageUrl('https://images.metmuseum.org/a.jpg', base)).toBe('https://images.metmuseum.org/a.jpg');
    expect(imageUrl(`lots/${SELLER.userId}/0-abc123`, base)).toBe(`${base}/lots/${SELLER.userId}/0-abc123`);
    expect(imageUrl('http://inseguro.example/a.jpg', base)).toBeNull();
    expect(imageUrl('../../etc/passwd', base)).toBeNull();
  });

  it('solo el vendedor ve una obra privada', () => {
    const lot = { visibility: 'PRIVATE' as const, sellerId: SELLER.userId };
    expect(canViewLot(lot, SELLER.userId)).toBe(true);
    expect(canViewLot(lot, OTHER.userId)).toBe(false);
    expect(canViewLot(lot, null)).toBe(false);
  });
});

describe('casos de uso del catalogo', () => {
  it('crea la obra en borrador y emite LotCreated en el mismo paso', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    expect(lot.status).toBe('BORRADOR');
    expect(lot.visibility).toBe('PRIVATE');
    expect(repo.outbox.map((event) => event.type)).toEqual([CATALOG_EVENTS.lotCreated]);
  });

  it('no deja publicar a un comprador ni con una categoria inexistente', async () => {
    const repo = new MemoryLots();
    await expectKind(new CreateLot(repo).execute(BUYER, NEW_LOT), 'PERMISSION_DENIED');
    await expectKind(new CreateLot(repo).execute(SELLER, { ...NEW_LOT, categorySlug: 'nada' }), 'INVALID_ARGUMENT');
  });

  it('oculta la obra privada a terceros como si no existiera', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    await expect(new GetLotForViewer(repo).execute(lot.id, SELLER.userId)).resolves.toMatchObject({ id: lot.id });
    await expectKind(new GetLotForViewer(repo).execute(lot.id, OTHER.userId), 'NOT_FOUND');
  });

  it('envia a auditoria con evento y rechaza un segundo envio', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    await new SubmitLot(repo).execute(SELLER, lot.id);
    expect(repo.lots.get(lot.id)?.status).toBe('PENDIENTE_AUDITORIA');
    expect(repo.outbox.at(-1)?.type).toBe(CATALOG_EVENTS.lotSubmitted);
    await expectKind(new SubmitLot(repo).execute(SELLER, lot.id), 'INVALID_ARGUMENT');
    await expectKind(new SubmitLot(repo).execute(OTHER, lot.id), 'NOT_FOUND');
  });

  it('firma subidas con clave propia y solo registra claves de la obra', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    const signer = { sign: (objectKey: string) => Promise.resolve({ uploadUrl: `https://s3/${objectKey}`, objectKey, expiresAt: new Date(0) }) };
    const signed = await new SignImageUpload(repo, signer, { next: () => 'abc123' }).execute(SELLER, {
      lotId: lot.id,
      contentType: 'image/jpeg',
      position: 0,
    });
    expect(signed.objectKey).toBe(`lots/${lot.id}/0-abc123`);
    await expectKind(
      new SignImageUpload(repo, signer, { next: () => 'x' }).execute(SELLER, { lotId: lot.id, contentType: 'text/html', position: 0 }),
      'INVALID_ARGUMENT',
    );
    const register = new RegisterLotImage(repo);
    await expect(register.execute(SELLER, { lotId: lot.id, objectKey: signed.objectKey, position: 0 })).resolves.toBeDefined();
    await expectKind(register.execute(SELLER, { lotId: lot.id, objectKey: 'lots/otra-obra/0-abc', position: 0 }), 'INVALID_ARGUMENT');
  });

  it('la revision manual publica la obra y emite LotPublished; solo un admin', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    repo.lots.set(lot.id, { ...lot, status: 'REVISION_MANUAL', authenticityScore: 35, suggestedPriceMin: '120.00', suggestedPriceMax: '180.00' });
    await expectKind(new ResolveManualReview(repo).execute(SELLER, lot.id, 'APPROVE'), 'PERMISSION_DENIED');
    const resolved = await new ResolveManualReview(repo).execute(ADMIN, lot.id, 'APPROVE');
    expect(resolved).toMatchObject({ status: 'PUBLICADA', visibility: 'PUBLIC' });
    expect(repo.outbox.at(-1)).toMatchObject({
      type: CATALOG_EVENTS.lotPublished,
      payload: { lotId: lot.id, score: 35, priceMin: 120, priceMax: 180 },
    });
  });

  it('aplica un evento entrante una sola vez y nunca retrocede el estado', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    repo.lots.set(lot.id, { ...lot, status: 'EN_SUBASTA', visibility: 'PUBLIC' });
    const sold = new MarkLotSold(repo);
    await expect(sold.execute({ eventId: 'e1', lotId: lot.id })).resolves.toBe(true);
    expect(repo.lots.get(lot.id)).toMatchObject({ status: 'VENDIDA', visibility: 'PRIVATE' });
    await expect(sold.execute({ eventId: 'e1', lotId: lot.id })).resolves.toBe(false);
    await sold.execute({ eventId: 'e2', lotId: lot.id });
    expect(repo.lots.get(lot.id)?.status).toBe('VENDIDA');
  });

  it('acota la paginacion del listado publico', async () => {
    const repo = new MemoryLots();
    const page = await new ListPublicLots(repo).execute({ page: 0, pageSize: 500, text: '   ' });
    expect(page).toMatchObject({ page: 1, pageSize: 60 });
    expect(repo.lastQuery[0]?.text).toBeNull();
  });

  it('busca imagenes parecidas en otras obras y valida la consulta', async () => {
    const lots = new MemoryLots();
    const create = new CreateLot(lots);
    const mine = await create.execute(SELLER, NEW_LOT);
    const theirs = await create.execute(OTHER, NEW_LOT);
    lots.lots.set(theirs.id, { ...theirs, images: [{ id: 'i1', objectKey: 'k', position: 0, perceptualHash: 'ffffffffffffff00', createdAt: new Date() }] });
    const similar = new FindSimilarImages(lots);
    const matches = await similar.execute(mine.id, ['FFFFFFFFFFFFFF0F'], 6);
    expect(matches).toEqual([
      { lotId: theirs.id, sellerId: OTHER.userId, queryHash: 'ffffffffffffff0f', matchedHash: 'ffffffffffffff00', distance: 4 },
    ]);
    expect(await similar.execute(mine.id, ['0000000000000000'], 6)).toEqual([]);
    await expect(similar.execute(mine.id, ['no-es-hash'], 6)).rejects.toBeInstanceOf(DomainError);
    await expect(similar.execute(mine.id, ['ffffffffffffff00'], 40)).rejects.toBeInstanceOf(DomainError);
  });

  it('solo un administrador ve la cola de revision manual', async () => {
    const lots = new MemoryLots();
    const draft = await new CreateLot(lots).execute(SELLER, NEW_LOT);
    lots.lots.set(draft.id, { ...draft, status: 'REVISION_MANUAL' });
    const queue = new ListReviewQueue(lots);
    expect((await queue.execute(ADMIN, 10)).map((lot) => lot.id)).toEqual([draft.id]);
    await expectKind(queue.execute(SELLER, 10), 'PERMISSION_DENIED');
  });
});
