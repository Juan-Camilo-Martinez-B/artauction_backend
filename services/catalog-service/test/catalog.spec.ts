import { DomainError, type DomainEvent } from '@artauction/platform';
import { CATALOG_EVENTS } from '../src/internal/domain/events';
import { canViewLot, imageUrl, parseNewLot, type Actor, type Category, type Lot, type LotImage, type LotModel, type NewLot } from '../src/internal/domain/lot';
import { canTransition, type LotStatus } from '../src/internal/domain/lot-status';
import type { LotPatch, LotRepository, LotTransitions, NewLotReview, PublicLotQuery, SimilarImage } from '../src/internal/application/ports';
import {
  CreateLot,
  RegisterLotImage,
  RegisterLotModel,
  RemoveLotModel,
  ResolveManualReview,
  SetLotVisibility,
  SignImageUpload,
  SignModelUpload,
  SubmitLot,
  UpdateLot,
} from '../src/internal/application/commands';
import { MarkLotSold } from '../src/internal/application/event-handlers';
import { BatchGetPublicLots, FindSimilarImages, GetLotForViewer, ListAuctionCandidates, ListMyLots, ListPublicLots, ListReviewQueue } from '../src/internal/application/queries';
import { hasSuggestedPrice, planReview } from '../src/internal/domain/review';

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

  readonly sampleLimits: number[] = [];

  sampleAuctionable(limit: number) {
    this.sampleLimits.push(limit);
    const auctionable = [...this.lots.values()].filter(
      (lot) => lot.status === 'PUBLICADA' && lot.visibility === 'PUBLIC' && lot.suggestedPriceMin !== null,
    );
    return Promise.resolve(auctionable.slice(0, limit));
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

  create(sellerId: string, lot: NewLot, _categoryId: string, initial: { status: LotStatus; visibility: Lot['visibility'] }, events: (lot: Lot) => DomainEvent[]) {
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
      status: initial.status,
      visibility: initial.visibility,
      authenticityScore: null,
      suggestedPriceMin: null,
      suggestedPriceMax: null,
      currency: 'USD',
      createdAt: new Date(0),
      images: [],
      categories: [{ isPrimary: true, category: PAINTINGS }],
      lastReview: null,
      model: null,
    };
    this.lots.set(created.id, created);
    this.outbox.push(...events(created));
    return Promise.resolve(created);
  }

  saveModel(lotId: string, model: Omit<LotModel, 'createdAt'>) {
    const saved: LotModel = { ...model, createdAt: new Date(0) };
    const lot = this.lots.get(lotId);
    if (lot) this.lots.set(lotId, { ...lot, model: saved });
    return Promise.resolve(saved);
  }

  removeModel(lotId: string) {
    const lot = this.lots.get(lotId);
    if (lot) this.lots.set(lotId, { ...lot, model: null });
    return Promise.resolve();
  }

  upsertImage(lotId: string, image: { objectKey: string; position: number; perceptualHash: string | null }): Promise<LotImage> {
    return Promise.resolve({ id: `${lotId}-img`, createdAt: new Date(0), ...image });
  }

  readonly reviews: NewLotReview[] = [];

  update(lotId: string, lot: NewLot) {
    const current = this.lots.get(lotId);
    if (!current || !['BORRADOR', 'PERSONAL'].includes(current.status)) {
      return Promise.resolve(null);
    }
    const next: Lot = { ...current, ...lot };
    this.lots.set(lotId, next);
    return Promise.resolve(next);
  }

  listBySeller(sellerId: string, limit: number) {
    return Promise.resolve([...this.lots.values()].filter((lot) => lot.sellerId === sellerId).slice(0, limit));
  }

  transition(lotId: string, from: LotStatus, to: LotStatus, patch: LotPatch, events: (lot: Lot) => DomainEvent[], review?: NewLotReview) {
    const lot = this.lots.get(lotId);
    if (!lot || lot.status !== from) {
      return Promise.resolve(null);
    }
    if (review) {
      this.reviews.push(review);
    }
    const next: Lot = {
      ...lot,
      ...patch,
      status: to,
      lastReview: review ? { decision: review.decision, reason: review.reason, createdAt: new Date(0) } : lot.lastReview,
    };
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
    await expectKind(new ResolveManualReview(repo).execute(SELLER, lot.id, { decision: 'APPROVE' }), 'PERMISSION_DENIED');
    const resolved = await new ResolveManualReview(repo).execute(ADMIN, lot.id, { decision: 'APPROVE' });
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

  it('acota la muestra de candidatas a subasta rotativa', async () => {
    const lots = new MemoryLots();
    const candidates = new ListAuctionCandidates(lots);
    await candidates.execute(0);
    await candidates.execute(500);
    await candidates.execute(7);
    expect(lots.sampleLimits).toEqual([20, 50, 7]);
  });

  it('la revision guarda la decision en el historial, en el mismo paso', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    repo.lots.set(lot.id, { ...lot, status: 'REVISION_MANUAL', suggestedPriceMin: '120.00', suggestedPriceMax: '180.00' });
    await new ResolveManualReview(repo).execute(ADMIN, lot.id, { decision: 'APPROVE' });
    expect(repo.reviews).toEqual([{ adminId: ADMIN.userId, decision: 'APPROVE', reason: null, priceMin: null, priceMax: null }]);
  });
});

describe('ciclo de revision', () => {
  async function inReview(repo: MemoryLots, prices: { min: string | null; max: string | null } = { min: null, max: null }) {
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    repo.lots.set(lot.id, { ...lot, status: 'REVISION_MANUAL', authenticityScore: 0, suggestedPriceMin: prices.min, suggestedPriceMax: prices.max });
    return lot.id;
  }

  it('devolver a borrador exige un motivo y avisa al vendedor con el', async () => {
    const repo = new MemoryLots();
    const lotId = await inReview(repo);
    const resolve = new ResolveManualReview(repo);
    await expectKind(resolve.execute(ADMIN, lotId, { decision: 'RETURN_TO_DRAFT' }), 'INVALID_ARGUMENT');
    await expectKind(resolve.execute(ADMIN, lotId, { decision: 'RETURN_TO_DRAFT', reason: 'corto' }), 'INVALID_ARGUMENT');
    const returned = await resolve.execute(ADMIN, lotId, { decision: 'RETURN_TO_DRAFT', reason: '  Las medidas   no son creibles para una fotografia.  ' });
    expect(returned).toMatchObject({ status: 'BORRADOR', visibility: 'PRIVATE' });
    expect(returned.lastReview).toMatchObject({ decision: 'RETURN_TO_DRAFT', reason: 'Las medidas no son creibles para una fotografia.' });
    expect(repo.outbox.at(-1)).toMatchObject({
      type: CATALOG_EVENTS.lotReturnedToDraft,
      payload: { lotId, sellerId: SELLER.userId, reason: 'Las medidas no son creibles para una fotografia.' },
    });
  });

  it('el vendedor edita la obra devuelta y la reenvia; otra persona no puede', async () => {
    const repo = new MemoryLots();
    const lotId = await inReview(repo);
    await new ResolveManualReview(repo).execute(ADMIN, lotId, { decision: 'RETURN_TO_DRAFT', reason: 'Corrige las medidas declaradas.' });
    const update = new UpdateLot(repo);
    await expectKind(update.execute(OTHER, lotId, { ...NEW_LOT, widthCm: '30' }), 'NOT_FOUND');
    const edited = await update.execute(SELLER, lotId, { ...NEW_LOT, widthCm: '30', heightCm: '40' });
    expect(edited).toMatchObject({ widthCm: '30', heightCm: '40', status: 'BORRADOR' });
    await new SubmitLot(repo).execute(SELLER, lotId);
    expect(repo.lots.get(lotId)?.status).toBe('PENDIENTE_AUDITORIA');
    expect(repo.outbox.at(-1)?.type).toBe(CATALOG_EVENTS.lotSubmitted);
  });

  it('una obra fuera de borrador no cambia de ficha ni de imagen', async () => {
    const repo = new MemoryLots();
    const lotId = await inReview(repo);
    repo.lots.set(lotId, { ...(repo.lots.get(lotId) as Lot), status: 'PUBLICADA' });
    await expectKind(new UpdateLot(repo).execute(SELLER, lotId, NEW_LOT), 'FAILED_PRECONDITION');
    const signer = { sign: (objectKey: string) => Promise.resolve({ uploadUrl: `https://s3/${objectKey}`, objectKey, expiresAt: new Date(0) }) };
    await expectKind(
      new SignImageUpload(repo, signer, { next: () => 'x' }).execute(SELLER, { lotId, contentType: 'image/jpeg', position: 0 }),
      'FAILED_PRECONDITION',
    );
    await expectKind(new RegisterLotImage(repo).execute(SELLER, { lotId, objectKey: `lots/${lotId}/0-x`, position: 0 }), 'FAILED_PRECONDITION');
  });

  it('aprobar una obra sin precio exige el rango y lo publica con el', async () => {
    const repo = new MemoryLots();
    const lotId = await inReview(repo, { min: '0.00', max: '0.00' });
    const resolve = new ResolveManualReview(repo);
    await expectKind(resolve.execute(ADMIN, lotId, { decision: 'APPROVE' }), 'INVALID_ARGUMENT');
    await expectKind(resolve.execute(ADMIN, lotId, { decision: 'APPROVE', priceMin: 500, priceMax: 300 }), 'INVALID_ARGUMENT');
    const approved = await resolve.execute(ADMIN, lotId, { decision: 'APPROVE', priceMin: 300, priceMax: 500 });
    expect(approved).toMatchObject({ status: 'PUBLICADA', suggestedPriceMin: '300.00', suggestedPriceMax: '500.00' });
    expect(repo.outbox.at(-1)).toMatchObject({ type: CATALOG_EVENTS.lotPublished, payload: { priceMin: 300, priceMax: 500 } });
    expect(repo.reviews.at(-1)).toMatchObject({ decision: 'APPROVE', priceMin: 300, priceMax: 500 });
  });

  it('re-auditar vuelve a pedir la auditoria', async () => {
    const repo = new MemoryLots();
    const lotId = await inReview(repo);
    const reaudited = await new ResolveManualReview(repo).execute(ADMIN, lotId, { decision: 'REAUDIT' });
    expect(reaudited.status).toBe('PENDIENTE_AUDITORIA');
    expect(repo.outbox.at(-1)).toMatchObject({ type: CATALOG_EVENTS.lotSubmitted, payload: { lotId } });
  });

  it('cada persona ve solo sus obras; un comprador sin proyectos no tiene ninguna', async () => {
    const repo = new MemoryLots();
    await new CreateLot(repo).execute(SELLER, NEW_LOT);
    await new CreateLot(repo).execute(OTHER, NEW_LOT);
    expect(await new ListMyLots(repo).execute(SELLER)).toHaveLength(1);
    expect(await new ListMyLots(repo).execute(BUYER)).toEqual([]);
  });

  it('reglas puras de la revision', () => {
    expect(hasSuggestedPrice({ suggestedPriceMin: '0.00', suggestedPriceMax: '0.00' })).toBe(false);
    expect(hasSuggestedPrice({ suggestedPriceMin: '120.00', suggestedPriceMax: '180.00' })).toBe(true);
    const priced = { suggestedPriceMin: '120.00', suggestedPriceMax: '180.00' };
    expect(planReview(priced, { decision: 'APPROVE' })).toMatchObject({ to: 'PUBLICADA', priceMin: null });
    expect(() => planReview(priced, { decision: 'APPROVE', priceMin: 100 })).toThrow('minimo y el maximo');
    expect(() => planReview(priced, { decision: 'APPROVE', priceMin: 1.5, priceMax: 3 })).toThrow('enteras');
  });
});

describe('proyectos propios', () => {
  it('cualquier cuenta crea un proyecto propio; al catalogo solo publica quien vende', async () => {
    const repo = new MemoryLots();
    await expectKind(new CreateLot(repo).execute(BUYER, NEW_LOT), 'PERMISSION_DENIED');
    await expectKind(new CreateLot(repo).execute(BUYER, { ...NEW_LOT, destination: 'CATALOG' }), 'PERMISSION_DENIED');
    const own = await new CreateLot(repo).execute(BUYER, { ...NEW_LOT, destination: 'PERSONAL' });
    expect(own).toMatchObject({ status: 'PERSONAL', visibility: 'PRIVATE', authenticityScore: null });
    expect(repo.outbox.at(-1)).toMatchObject({ type: CATALOG_EVENTS.lotCreated, payload: { personal: true, visibility: 'PRIVATE' } });
    const shown = await new CreateLot(repo).execute(SELLER, { ...NEW_LOT, destination: 'PERSONAL', visibility: 'PUBLIC' });
    expect(shown.visibility).toBe('PUBLIC');
    // Una obra del catalogo siempre nace privada: la publica la auditoria.
    const catalog = await new CreateLot(repo).execute(SELLER, { ...NEW_LOT, visibility: 'PUBLIC' });
    expect(catalog).toMatchObject({ status: 'BORRADOR', visibility: 'PRIVATE' });
    expect(repo.outbox.at(-1)).toMatchObject({ payload: { personal: false } });
  });

  it('nunca aparece en el catalogo, aunque sea publico', async () => {
    const repo = new MemoryLots();
    const own = await new CreateLot(repo).execute(BUYER, { ...NEW_LOT, destination: 'PERSONAL', visibility: 'PUBLIC' });
    expect(await new BatchGetPublicLots(repo).execute([own.id])).toEqual([]);
    // La ficha si se puede abrir desde la galeria publica del autor.
    expect(await new GetLotForViewer(repo).execute(own.id, null)).toMatchObject({ id: own.id });
  });

  it('el autor lo edita, cambia su imagen y su visibilidad; nadie mas', async () => {
    const repo = new MemoryLots();
    const own = await new CreateLot(repo).execute(BUYER, { ...NEW_LOT, destination: 'PERSONAL' });
    expect(await new UpdateLot(repo).execute(BUYER, own.id, { ...NEW_LOT, title: 'Boceto corregido' })).toMatchObject({ title: 'Boceto corregido', status: 'PERSONAL' });
    await expectKind(new UpdateLot(repo).execute(SELLER, own.id, NEW_LOT), 'NOT_FOUND');
    expect(await new RegisterLotImage(repo).execute(BUYER, { lotId: own.id, objectKey: `lots/${own.id}/0-x`, position: 0 })).toMatchObject({ position: 0 });

    const visibility = new SetLotVisibility(repo);
    await expectKind(visibility.execute(SELLER, own.id, 'PUBLIC'), 'NOT_FOUND');
    expect((await visibility.execute(BUYER, own.id, 'PUBLIC')).visibility).toBe('PUBLIC');
    expect(repo.outbox.at(-1)).toMatchObject({ type: CATALOG_EVENTS.lotVisibilityChanged, payload: { lotId: own.id, ownerId: BUYER.userId, visibility: 'PUBLIC' } });
    const events = repo.outbox.length;
    await visibility.execute(BUYER, own.id, 'PUBLIC');
    expect(repo.outbox).toHaveLength(events);
  });

  it('la visibilidad de una obra del catalogo no se cambia a mano', async () => {
    const repo = new MemoryLots();
    const lot = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    await expectKind(new SetLotVisibility(repo).execute(SELLER, lot.id, 'PUBLIC'), 'FAILED_PRECONDITION');
  });

  it('pasar al catalogo lo audita y lo oculta mientras tanto; solo si vende', async () => {
    const repo = new MemoryLots();
    const mine = await new CreateLot(repo).execute(BUYER, { ...NEW_LOT, destination: 'PERSONAL', visibility: 'PUBLIC' });
    await expectKind(new SubmitLot(repo).execute(BUYER, mine.id), 'PERMISSION_DENIED');
    const own = await new CreateLot(repo).execute(SELLER, { ...NEW_LOT, destination: 'PERSONAL', visibility: 'PUBLIC' });
    await new SubmitLot(repo).execute(SELLER, own.id);
    expect(repo.lots.get(own.id)).toMatchObject({ status: 'PENDIENTE_AUDITORIA', visibility: 'PRIVATE' });
    expect(repo.outbox.at(-1)).toMatchObject({ type: CATALOG_EVENTS.lotSubmitted, payload: { lotId: own.id } });
    // Ya en auditoria, deja de ser editable como cualquier obra del catalogo.
    await expectKind(new UpdateLot(repo).execute(SELLER, own.id, NEW_LOT), 'FAILED_PRECONDITION');
  });
});

describe('modelo 3D de una obra tridimensional', () => {
  /** GLB minimo valido: una malla de `triangles` caras dentro de una caja de 0,4 x 1,8 x 0,3. */
  function glb(triangles: number): Uint8Array {
    const json = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
          { count: triangles, type: 'VEC3', componentType: 5126, min: [-0.2, 0, -0.15], max: [0.2, 1.8, 0.15] },
          { count: triangles * 3, type: 'SCALAR', componentType: 5125 },
        ],
        buffers: [{ byteLength: 4 }],
      }),
    );
    const padded = Math.ceil(json.length / 4) * 4;
    const bytes = new Uint8Array(12 + 8 + padded);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, bytes.length, true);
    view.setUint32(12, padded, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.fill(0x20, 20);
    bytes.set(json, 20);
    return bytes;
  }

  const SCULPTURE = { ...NEW_LOT, representationKind: 'THREE_D' as const, depthCm: '30' };
  const signer = { sign: (objectKey: string, contentType: string) => Promise.resolve({ uploadUrl: `https://s3/${objectKey}?type=${contentType}`, objectKey, expiresAt: new Date(0) }) };
  const reader = (file: Uint8Array) => ({ read: () => Promise.resolve(file) });

  it('firma la subida de un .glb bajo el prefijo de la obra, solo en una obra tridimensional', async () => {
    const repo = new MemoryLots();
    const sculpture = await new CreateLot(repo).execute(SELLER, SCULPTURE);
    const signed = await new SignModelUpload(repo, signer, { next: () => 'abc123' }).execute(SELLER, { lotId: sculpture.id, contentType: 'model/gltf-binary' });
    expect(signed.objectKey).toBe(`lots/${sculpture.id}/model-abc123.glb`);
    await expectKind(new SignModelUpload(repo, signer, { next: () => 'x' }).execute(SELLER, { lotId: sculpture.id, contentType: 'image/png' }), 'INVALID_ARGUMENT');
    const painting = await new CreateLot(repo).execute(SELLER, NEW_LOT);
    await expectKind(new SignModelUpload(repo, signer, { next: () => 'x' }).execute(SELLER, { lotId: painting.id, contentType: 'model/gltf-binary' }), 'FAILED_PRECONDITION');
    await expectKind(new SignModelUpload(repo, signer, { next: () => 'x' }).execute(OTHER, { lotId: sculpture.id, contentType: 'model/gltf-binary' }), 'NOT_FOUND');
  });

  it('registra el modelo medido: triangulos, vertices, caja y bytes', async () => {
    const repo = new MemoryLots();
    const sculpture = await new CreateLot(repo).execute(SELLER, SCULPTURE);
    const file = glb(12_000);
    const model = await new RegisterLotModel(repo, reader(file)).execute(SELLER, { lotId: sculpture.id, objectKey: `lots/${sculpture.id}/model-abc123.glb` });
    expect(model).toMatchObject({ triangleCount: 12_000, vertexCount: 12_000, sizeX: 0.4, sizeY: 1.8, bytes: file.byteLength });
    expect(repo.lots.get(sculpture.id)?.model?.triangleCount).toBe(12_000);
    await new RemoveLotModel(repo).execute(SELLER, sculpture.id);
    expect(repo.lots.get(sculpture.id)?.model).toBeNull();
  });

  it('no registra la clave de otra obra ni un modelo fuera de los limites', async () => {
    const repo = new MemoryLots();
    const sculpture = await new CreateLot(repo).execute(SELLER, SCULPTURE);
    const register = new RegisterLotModel(repo, reader(glb(12_000)));
    await expectKind(register.execute(SELLER, { lotId: sculpture.id, objectKey: 'lots/b0000000-0000-4000-8000-000000000099/model-abc.glb' }), 'INVALID_ARGUMENT');
    await expectKind(register.execute(SELLER, { lotId: sculpture.id, objectKey: `lots/${sculpture.id}/model-a.glb?x=1` }), 'INVALID_ARGUMENT');
    await expectKind(new RegisterLotModel(repo, reader(glb(50))).execute(SELLER, { lotId: sculpture.id, objectKey: `lots/${sculpture.id}/model-abc.glb` }), 'INVALID_ARGUMENT');
    expect(repo.lots.get(sculpture.id)?.model).toBeNull();
  });

  it('una obra auditada no cambia de modelo sin volver a auditarse', async () => {
    const repo = new MemoryLots();
    const sculpture = await new CreateLot(repo).execute(SELLER, SCULPTURE);
    repo.lots.set(sculpture.id, { ...(repo.lots.get(sculpture.id) as Lot), status: 'PUBLICADA' });
    await expectKind(
      new RegisterLotModel(repo, reader(glb(12_000))).execute(SELLER, { lotId: sculpture.id, objectKey: `lots/${sculpture.id}/model-abc.glb` }),
      'FAILED_PRECONDITION',
    );
    await expectKind(new RemoveLotModel(repo).execute(SELLER, sculpture.id), 'FAILED_PRECONDITION');
  });
});
