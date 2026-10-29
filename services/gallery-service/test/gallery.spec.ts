import { DomainError } from '@artauction/platform';
import { designFromPreferences, GALLERY_CONFIG_JSON_SCHEMA, randomPreferences } from '../src/internal/domain/gallery-design';
import { initialPlacement, placeArtwork, type Activity, type Artwork, type GalleryItem, type PersonalGallery, type PublicLot } from '../src/internal/domain/gallery';
import type { CatalogPort, GalleryPatch, GalleryRepository, IdentityPort, SocialStore } from '../src/internal/application/ports';
import { GalleryEventHandlers, PersonalGalleryUseCases, SocialUseCases } from '../src/internal/application/use-cases';

const OWNER = 'a0000000-0000-4000-8000-000000000003';
const OTHER = 'a0000000-0000-4000-8000-000000000004';
const LOT = 'c0000000-0000-4000-8000-0000000032aa';
const SCULPTURE = 'c0000000-0000-4000-8000-00000003d4eb';
const clock = { now: () => new Date('2026-10-29T12:00:00Z') };

class MemoryGalleries implements GalleryRepository {
  galleries = new Map<string, PersonalGallery>();
  follows = new Set<string>();
  inbox = new Set<string>();
  private seq = 0;

  mine(ownerId: string) {
    const found = this.galleries.get(ownerId);
    if (found) {
      return Promise.resolve(structuredClone(found));
    }
    const created: PersonalGallery = {
      id: `g-${ownerId}`,
      ownerId,
      name: 'Mi galería',
      customizationStatus: 'SIN_PERSONALIZAR',
      preferences: {},
      suggestedConfig: null,
      appliedConfig: null,
      artworks: [],
    };
    this.galleries.set(ownerId, created);
    return Promise.resolve(structuredClone(created));
  }
  find(ownerId: string) {
    const found = this.galleries.get(ownerId);
    return Promise.resolve(found ? structuredClone(found) : null);
  }
  private byId(galleryId: string): PersonalGallery {
    const found = [...this.galleries.values()].find((gallery) => gallery.id === galleryId);
    if (!found) throw new Error('sin galeria');
    return found;
  }
  update(galleryId: string, patch: GalleryPatch) {
    Object.assign(this.byId(galleryId), patch);
    return Promise.resolve();
  }
  addArtwork(galleryId: string, lotId: string, placement: Omit<Artwork, 'id' | 'lotId'>) {
    const gallery = this.byId(galleryId);
    if (!gallery.artworks.some((artwork) => artwork.lotId === lotId)) {
      this.seq += 1;
      gallery.artworks.push({ id: `art-${String(this.seq)}`, lotId, ...placement });
    }
    return Promise.resolve();
  }
  removeArtwork(galleryId: string, lotId: string) {
    const gallery = this.byId(galleryId);
    gallery.artworks = gallery.artworks.filter((artwork) => artwork.lotId !== lotId);
    return Promise.resolve();
  }
  moveArtwork(artworkId: string, placement: Omit<Artwork, 'id' | 'lotId'>) {
    for (const gallery of this.galleries.values()) {
      const artwork = gallery.artworks.find((item) => item.id === artworkId);
      if (artwork) Object.assign(artwork, placement);
    }
    return Promise.resolve();
  }
  follow(followerId: string, followeeId: string) {
    const key = `${followerId}>${followeeId}`;
    const fresh = !this.follows.has(key);
    this.follows.add(key);
    return Promise.resolve(fresh);
  }
  seen(eventId: string) {
    return Promise.resolve(this.inbox.has(eventId));
  }
  recordEvent(eventId: string) {
    this.inbox.add(eventId);
    return Promise.resolve();
  }
}

class MemorySocial implements SocialStore {
  items = new Map<string, GalleryItem>();
  activity = new Map<string, Activity>();
  upsertItem(id: string, item: GalleryItem) {
    if (!this.items.has(id)) this.items.set(id, item);
    return Promise.resolve();
  }
  itemsOf(ownerId: string) {
    return Promise.resolve([...this.items.values()].filter((item) => item.ownerId === ownerId));
  }
  upsertActivity(id: string, activity: Activity) {
    if (!this.activity.has(id)) this.activity.set(id, activity);
    return Promise.resolve();
  }
  feed(viewerId: string) {
    return Promise.resolve([...this.activity.values()].filter((item) => item.visibility === 'PUBLIC' || item.actorId === viewerId));
  }
}

const LOTS: Record<string, PublicLot> = {
  [LOT]: { lotId: LOT, title: 'Study in Black and Green', artistName: 'J. W. Alexander', representationKind: 'TWO_D', imageKeys: ['lots/x/1.jpg'] },
  [SCULPTURE]: { lotId: SCULPTURE, title: 'Aphrodite', artistName: null, representationKind: 'THREE_D', imageKeys: [] },
};
const catalog: CatalogPort = {
  publicLot: (lotId) => Promise.resolve(LOTS[lotId] ?? null),
  snapshot: (lotId) => Promise.resolve(LOTS[lotId] ?? null),
};
const identity: IdentityPort = { displayName: (userId) => Promise.resolve(userId === OTHER ? 'Nora' : null) };
const designer = { design: (preferences: Parameters<typeof designFromPreferences>[0]) => Promise.resolve(designFromPreferences(preferences, 'ai-local')) };

async function expectKind(promise: Promise<unknown>, kind: string): Promise<void> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).kind).toBe(kind);
}

describe('reglas de la sala', () => {
  const empty: PersonalGallery = {
    id: 'g', ownerId: OWNER, name: 'Mi galería', customizationStatus: 'SIN_PERSONALIZAR',
    preferences: {}, suggestedConfig: null, appliedConfig: { architecture: { roomDepth: 12 } }, artworks: [],
  };

  it('cuelga la pintura en la pared del fondo y la escultura sobre pedestal', () => {
    expect(initialPlacement(empty, LOTS[LOT] as PublicLot)).toEqual({ posX: -3.2, posY: 1.55, posZ: -5.92, rotY: 0, scale: 1, support: 'WALL' });
    expect(initialPlacement(empty, LOTS[SCULPTURE] as PublicLot)).toMatchObject({ posX: -2, posY: 0, support: 'PEDESTAL' });
  });

  it('valida soporte y escala al mover una obra', () => {
    const current: Artwork = { id: 'a', lotId: LOT, posX: 0, posY: 1.5, posZ: -4, rotY: 0, scale: 1, support: 'WALL' };
    expect(placeArtwork(current, { posX: 2, scale: 2, support: 'NICHE' })).toMatchObject({ posX: 2, posY: 1.5, scale: 2, support: 'NICHE' });
    expect(() => placeArtwork(current, { support: 'TECHO' })).toThrow('Soporte no admitido.');
    expect(() => placeArtwork(current, { scale: 4 })).toThrow('La escala está fuera de rango.');
  });
});

describe('esquema de la sala para el modelo', () => {
  type Node = { required?: string[]; properties?: Record<string, Node> };

  function missing(node: Node, value: unknown, path: string): string[] {
    const record = (value ?? {}) as Record<string, unknown>;
    return (node.required ?? []).flatMap((key) => {
      const child = node.properties?.[key];
      const here = `${path}.${key}`;
      if (!(key in record)) return [here];
      return child?.properties ? missing(child, record[key], here) : [];
    });
  }

  it('el diseno local cumple los campos obligatorios del JSON Schema enviado a ai-service', () => {
    const config = designFromPreferences(randomPreferences(), 'ai-local');
    expect(missing(GALLERY_CONFIG_JSON_SCHEMA as Node, config, 'config')).toEqual([]);
  });
});

describe('galeria personal', () => {
  it('crea la sala al primer acceso y cuelga solo obras publicas, sin duplicarlas', async () => {
    const galleries = new MemoryGalleries();
    const personal = new PersonalGalleryUseCases(galleries, designer, catalog);
    expect((await personal.mine(OWNER)).artworks).toEqual([]);
    await personal.addArtwork(OWNER, LOT);
    const gallery = await personal.addArtwork(OWNER, LOT);
    expect(gallery.artworks).toHaveLength(1);
    await expectKind(personal.addArtwork(OWNER, 'c0000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    await expectKind(personal.addArtwork(OWNER, 'no-uuid'), 'INVALID_ARGUMENT');
  });

  it('genera la sala y pide confirmacion si hay cambios manuales', async () => {
    const galleries = new MemoryGalleries();
    const personal = new PersonalGalleryUseCases(galleries, designer, catalog);
    const generated = await personal.generate(OWNER, null, true, false);
    expect(generated.customizationStatus).toBe('PERSONALIZADA');
    const edited = { ...(generated.appliedConfig ?? {}), lighting: { ...((generated.appliedConfig?.['lighting'] as object | undefined) ?? {}), ambientIntensity: 0.2 } };
    expect((await personal.applyManual(OWNER, edited)).customizationStatus).toBe('EDITADA');
    await expectKind(personal.generate(OWNER, randomPreferences(), false, false), 'CONFLICT');
    expect((await personal.generate(OWNER, randomPreferences(), false, true)).customizationStatus).toBe('PERSONALIZADA');
    expect((await personal.restoreSuggested(OWNER)).customizationStatus).toBe('PERSONALIZADA');
  });

  it('rechaza una configuracion manual invalida y mover una obra que no esta', async () => {
    const galleries = new MemoryGalleries();
    const personal = new PersonalGalleryUseCases(galleries, designer, catalog);
    await personal.mine(OWNER);
    await expectKind(personal.applyManual(OWNER, { schemaVersion: 9 }), 'INVALID_ARGUMENT');
    await expectKind(personal.placeArtwork(OWNER, LOT, { posX: 1 }), 'NOT_FOUND');
  });
});

describe('galeria social y eventos', () => {
  it('sigue a otro usuario una sola vez y registra la actividad', async () => {
    const galleries = new MemoryGalleries();
    const social = new MemorySocial();
    const useCases = new SocialUseCases(galleries, social, identity, clock);
    await useCases.follow(OWNER, OTHER);
    await useCases.follow(OWNER, OTHER);
    expect([...social.activity.values()]).toEqual([expect.objectContaining({ verb: 'FOLLOW', summary: 'Siguió a Nora' })]);
    await expectKind(useCases.follow(OWNER, OWNER), 'INVALID_ARGUMENT');
    await expectKind(useCases.follow(OWNER, 'a0000000-0000-4000-8000-000000000009'), 'NOT_FOUND');
  });

  it('un evento repetido no duplica obras ni actividad, y lo privado solo lo ve su duenio', async () => {
    const galleries = new MemoryGalleries();
    const social = new MemorySocial();
    const handlers = new GalleryEventHandlers(galleries, social, catalog, clock);
    await handlers.lotCreated({ eventId: 'e1', lotId: LOT, sellerId: OWNER, title: 'Study', artistName: null });
    await handlers.auctionClosed({ eventId: 'e2', lotId: LOT, winnerId: OTHER });
    galleries.inbox.clear();
    await handlers.auctionClosed({ eventId: 'e2', lotId: LOT, winnerId: OTHER });
    await handlers.auctionClosed({ eventId: 'e3', lotId: LOT, winnerId: null });
    expect(social.items.size).toBe(2);
    expect(social.activity.size).toBe(1);
    const useCases = new SocialUseCases(galleries, social, identity, clock);
    expect(await useCases.items(OTHER, OTHER)).toEqual([expect.objectContaining({ source: 'GANADA', imageKeys: ['lots/x/1.jpg'] })]);
    expect(await useCases.items(OTHER, OWNER)).toEqual([]);
    expect(await useCases.feed(OWNER)).toEqual([expect.objectContaining({ verb: 'WIN', summary: 'Ganó Study in Black and Green' })]);
  });
});
