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
  itemOf(ownerId: string, lotId: string) {
    return Promise.resolve([...this.items.values()].find((item) => item.ownerId === ownerId && item.lotId === lotId) ?? null);
  }
  itemsOfLot(lotId: string) {
    return Promise.resolve([...this.items.values()].filter((item) => item.lotId === lotId));
  }
  updateItem(ownerId: string, lotId: string, patch: Partial<Pick<GalleryItem, 'source' | 'visibility'>>) {
    for (const [id, item] of this.items) {
      if (item.ownerId === ownerId && item.lotId === lotId) this.items.set(id, { ...item, ...patch });
    }
    return Promise.resolve();
  }
  removeItem(ownerId: string, lotId: string) {
    for (const [id, item] of this.items) {
      if (item.ownerId === ownerId && item.lotId === lotId) this.items.delete(id);
    }
    return Promise.resolve();
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
  snapshot: (lotId) => Promise.resolve(LOTS[lotId] ?? null),
};

/** La obra es de `ownerId`, como la deja LotCreated o AuctionClosed. */
function own(social: MemorySocial, ownerId: string, lotId: string, source: GalleryItem['source'] = 'PROPIA') {
  return social.upsertItem(`${source}:${lotId}:${ownerId}`, {
    ownerId, lotId, source, visibility: 'PRIVATE', title: 'Obra', artistName: null, imageKeys: [], acquiredAt: clock.now(),
  });
}
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

  const wall = (posX: number, posZ: number, rotY = 0): Artwork => ({ id: `w${String(posX)}${String(posZ)}`, lotId: LOT, posX, posY: 1.55, posZ, rotY, scale: 1, support: 'WALL' });
  const plinth = (posX: number, posZ: number): Artwork => ({ id: `p${String(posX)}${String(posZ)}`, lotId: SCULPTURE, posX, posY: 0, posZ, rotY: 0, scale: 1, support: 'PEDESTAL' });

  it('cuelga la primera pintura en el primer hueco del fondo y la escultura al centro', () => {
    // Sala de 12 x 12: el fondo tiene 5 huecos de 2 m, centrados.
    expect(initialPlacement(empty, LOTS[LOT] as PublicLot)).toEqual({ posX: -4, posY: 1.55, posZ: -5.96, rotY: 0, scale: 1, support: 'WALL' });
    expect(initialPlacement(empty, LOTS[SCULPTURE] as PublicLot)).toEqual({ posX: 0, posY: 0, posZ: 0, rotY: 0, scale: 1, support: 'PEDESTAL' });
  });

  it('no cuelga una obra encima de otra: con el fondo lleno pasa a la pared izquierda', () => {
    const full = { ...empty, artworks: [-4, -2, 0, 2, 4].map((x) => wall(x, -5.96)) };
    const next = initialPlacement(full, LOTS[LOT] as PublicLot);
    expect(next).toMatchObject({ posX: -5.96, posZ: 4, support: 'WALL' });
    expect(next.rotY).toBeCloseTo(Math.PI / 2);
  });

  it('reutiliza el hueco que dejo una obra retirada', () => {
    const gap = { ...empty, artworks: [-4, 0, 2].map((x) => wall(x, -5.96)) };
    expect(initialPlacement(gap, LOTS[LOT] as PublicLot)).toMatchObject({ posX: -2, posZ: -5.96 });
  });

  it('pone el segundo pedestal en el siguiente punto libre de la reticula', () => {
    const one = { ...empty, artworks: [plinth(0, 0)] };
    expect(initialPlacement(one, LOTS[SCULPTURE] as PublicLot)).toMatchObject({ posX: 0, posZ: -2.4, support: 'PEDESTAL' });
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
  it('crea la sala al primer acceso y cuelga solo obras propias, sin duplicarlas', async () => {
    const galleries = new MemoryGalleries();
    const social = new MemorySocial();
    const personal = new PersonalGalleryUseCases(galleries, designer, catalog, social);
    expect((await personal.mine(OWNER)).artworks).toEqual([]);
    // Una obra ajena, aunque sea publica, no se cuelga.
    await expectKind(personal.addArtwork(OWNER, LOT), 'PERMISSION_DENIED');
    await own(social, OWNER, LOT);
    await personal.addArtwork(OWNER, LOT);
    const gallery = await personal.addArtwork(OWNER, LOT);
    expect(gallery.artworks).toHaveLength(1);
    await own(social, OWNER, 'c0000000-0000-4000-8000-000000000000');
    await expectKind(personal.addArtwork(OWNER, 'c0000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    await expectKind(personal.addArtwork(OWNER, 'no-uuid'), 'INVALID_ARGUMENT');
  });

  it('genera la sala y pide confirmacion si hay cambios manuales', async () => {
    const galleries = new MemoryGalleries();
    const personal = new PersonalGalleryUseCases(galleries, designer, catalog, new MemorySocial());
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
    const personal = new PersonalGalleryUseCases(galleries, designer, catalog, new MemorySocial());
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
    await handlers.lotCreated({ eventId: 'e1', lotId: LOT, sellerId: OWNER, title: 'Study', artistName: null, personal: false, visibility: 'PRIVATE' });
    await handlers.auctionClosed({ eventId: 'e2', lotId: LOT, sellerId: OWNER, winnerId: OTHER });
    galleries.inbox.clear();
    await handlers.auctionClosed({ eventId: 'e2', lotId: LOT, sellerId: OWNER, winnerId: OTHER });
    await handlers.auctionClosed({ eventId: 'e3', lotId: LOT, sellerId: OWNER, winnerId: null });
    // Vendida: ya no es del autor, solo del ganador.
    expect(social.items.size).toBe(1);
    expect(social.activity.size).toBe(1);
    const useCases = new SocialUseCases(galleries, social, identity, clock);
    expect(await useCases.items(OTHER, OTHER)).toEqual([expect.objectContaining({ source: 'GANADA', imageKeys: ['lots/x/1.jpg'] })]);
    expect(await useCases.items(OTHER, OWNER)).toEqual([]);
    expect(await useCases.feed(OWNER)).toEqual([expect.objectContaining({ verb: 'WIN', summary: 'Ganó Study in Black and Green' })]);
  });
});

describe('propiedad de las obras', () => {
  it('al venderse, la obra sale de la galeria y la sala del autor y entra en las del ganador', async () => {
    const galleries = new MemoryGalleries();
    const social = new MemorySocial();
    const handlers = new GalleryEventHandlers(galleries, social, catalog, clock);
    const personal = new PersonalGalleryUseCases(galleries, designer, catalog, social);
    await handlers.lotCreated({ eventId: 'e1', lotId: LOT, sellerId: OWNER, title: 'Study', artistName: null, personal: false, visibility: 'PRIVATE' });
    // Mientras no se vende, el autor la puede colgar.
    expect((await personal.addArtwork(OWNER, LOT)).artworks).toHaveLength(1);
    await handlers.auctionClosed({ eventId: 'e2', lotId: LOT, sellerId: OWNER, winnerId: OTHER });
    expect(await social.itemOf(OWNER, LOT)).toBeNull();
    expect((await personal.mine(OWNER)).artworks).toEqual([]);
    await expectKind(personal.addArtwork(OWNER, LOT), 'PERMISSION_DENIED');
    expect(await social.itemOf(OTHER, LOT)).toMatchObject({ source: 'GANADA' });
    // La obra ganada se cuelga sola en la sala del ganador.
    expect((await personal.mine(OTHER)).artworks).toEqual([expect.objectContaining({ lotId: LOT })]);
  });

  it('un proyecto propio llega con su visibilidad y se cuelga solo en la sala del autor', async () => {
    const galleries = new MemoryGalleries();
    const social = new MemorySocial();
    const handlers = new GalleryEventHandlers(galleries, social, catalog, clock);
    await handlers.lotCreated({ eventId: 'e1', lotId: SCULPTURE, sellerId: OWNER, title: 'Aphrodite', artistName: null, personal: true, visibility: 'PUBLIC' });
    expect(await social.itemOf(OWNER, SCULPTURE)).toMatchObject({ source: 'PROYECTO', visibility: 'PUBLIC' });
    expect((await galleries.mine(OWNER)).artworks).toEqual([expect.objectContaining({ lotId: SCULPTURE, support: 'PEDESTAL' })]);
    // Se ve en la galeria publica del autor.
    expect(await new SocialUseCases(galleries, social, identity, clock).items(OWNER, null)).toHaveLength(1);
  });

  it('el autor oculta su proyecto y, al pasarlo al catalogo, deja de ser PROYECTO y se oculta', async () => {
    const galleries = new MemoryGalleries();
    const social = new MemorySocial();
    const handlers = new GalleryEventHandlers(galleries, social, catalog, clock);
    await handlers.lotCreated({ eventId: 'e1', lotId: LOT, sellerId: OWNER, title: 'Study', artistName: null, personal: true, visibility: 'PUBLIC' });
    await handlers.lotVisibilityChanged({ eventId: 'e2', lotId: LOT, ownerId: OWNER, visibility: 'PRIVATE' });
    expect(await social.itemOf(OWNER, LOT)).toMatchObject({ visibility: 'PRIVATE' });
    await handlers.lotVisibilityChanged({ eventId: 'e3', lotId: LOT, ownerId: OWNER, visibility: 'PUBLIC' });
    await handlers.lotSubmitted({ eventId: 'e4', lotId: LOT });
    expect(await social.itemOf(OWNER, LOT)).toMatchObject({ source: 'PROPIA', visibility: 'PRIVATE' });
    // La visibilidad de una obra del catalogo ya no la cambia este evento.
    await handlers.lotVisibilityChanged({ eventId: 'e5', lotId: LOT, ownerId: OWNER, visibility: 'PUBLIC' });
    expect(await social.itemOf(OWNER, LOT)).toMatchObject({ visibility: 'PRIVATE' });
  });

  it('una compra inmediata sale en el feed como compra al instante', async () => {
    const galleries = new MemoryGalleries();
    const social = new MemorySocial();
    const handlers = new GalleryEventHandlers(galleries, social, catalog, clock);
    await handlers.auctionClosed({ eventId: 'e7', lotId: LOT, sellerId: OWNER, winnerId: OTHER, buyNow: true });
    expect([...social.activity.values()]).toEqual([expect.objectContaining({ verb: 'BUY_NOW', summary: 'Compró Study in Black and Green al instante' })]);
    expect(await social.itemOf(OTHER, LOT)).toMatchObject({ source: 'GANADA' });
  });
});
