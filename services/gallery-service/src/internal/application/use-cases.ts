import { DomainError } from '@artauction/platform';
import {
  configsDiffer,
  GalleryDesignError,
  parsePreferences,
  randomPreferences,
  validateGalleryConfig,
  type GalleryConfig,
  type GalleryPreferences,
} from '../domain/gallery-design';
import {
  asConfigRecord,
  canViewItem,
  hasManualChanges,
  initialPlacement,
  itemId,
  placeArtwork,
  type Activity,
  type GalleryItem,
  type PersonalGallery,
  type PublicLot,
  type Visibility,
} from '../domain/gallery';
import type { CatalogPort, Clock, GalleryDesigner, GalleryRepository, IdentityPort, SocialStore } from './ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_LIMIT = 50;

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) {
    throw DomainError.invalid(`${label} no es valido`);
  }
}

function readPreferences(body: unknown, random: boolean): GalleryPreferences {
  if (random) {
    return randomPreferences();
  }
  try {
    return parsePreferences(body);
  } catch (error) {
    throw DomainError.invalid(error instanceof Error ? error.message : 'Preferencias inválidas.');
  }
}

/** Cuelga una obra en el primer hueco libre de la sala de su duena; si ya estaba, no hace nada. */
async function hang(galleries: GalleryRepository, ownerId: string, lot: PublicLot): Promise<void> {
  const gallery = await galleries.mine(ownerId);
  if (gallery.artworks.some((artwork) => artwork.lotId === lot.lotId)) {
    return;
  }
  await galleries.addArtwork(gallery.id, lot.lotId, initialPlacement(gallery, lot));
}

function validConfig(input: unknown): GalleryConfig {
  try {
    return validateGalleryConfig(input);
  } catch (error) {
    throw DomainError.invalid(error instanceof GalleryDesignError ? error.message : 'Configuración inválida.');
  }
}

/** Casos de uso de la galeria 3D personal. Siempre actuan sobre la galeria de quien llama. */
export class PersonalGalleryUseCases {
  constructor(
    private readonly galleries: GalleryRepository,
    private readonly designer: GalleryDesigner,
    private readonly catalog: CatalogPort,
    private readonly social: SocialStore,
  ) {}

  mine(ownerId: string): Promise<PersonalGallery> {
    return this.galleries.mine(ownerId);
  }

  async savePreferences(ownerId: string, body: unknown, random: boolean): Promise<PersonalGallery> {
    const preferences = readPreferences(body, random);
    const gallery = await this.galleries.mine(ownerId);
    await this.galleries.update(gallery.id, { preferences: { ...preferences } });
    return this.galleries.mine(ownerId);
  }

  async generate(ownerId: string, body: unknown, random: boolean, replaceApplied: boolean): Promise<PersonalGallery> {
    const preferences = readPreferences(body, random);
    const gallery = await this.galleries.mine(ownerId);
    const designed = await this.designer.design(preferences);
    const config = validConfig(random ? { ...designed, source: 'random' } : designed);
    if (hasManualChanges(gallery, configsDiffer) && !replaceApplied) {
      throw DomainError.conflict('Hay cambios manuales. Confirma si quieres reemplazar la sala actual.');
    }
    await this.galleries.update(gallery.id, {
      preferences: { ...preferences },
      suggestedConfig: asConfigRecord(config),
      appliedConfig: asConfigRecord(config),
      customizationStatus: 'PERSONALIZADA',
    });
    return this.galleries.mine(ownerId);
  }

  async applyManual(ownerId: string, body: unknown): Promise<PersonalGallery> {
    const gallery = await this.owned(ownerId);
    const config = validConfig(typeof body === 'object' && body !== null ? { ...body, source: 'manual' } : body);
    await this.galleries.update(gallery.id, { appliedConfig: asConfigRecord(config), customizationStatus: 'EDITADA' });
    return this.galleries.mine(ownerId);
  }

  async restoreSuggested(ownerId: string): Promise<PersonalGallery> {
    const gallery = await this.owned(ownerId);
    if (gallery.suggestedConfig === null) {
      throw DomainError.invalid('Todavía no hay una propuesta de la IA.');
    }
    const config = validConfig(gallery.suggestedConfig);
    await this.galleries.update(gallery.id, { appliedConfig: asConfigRecord(config), customizationStatus: 'PERSONALIZADA' });
    return this.galleries.mine(ownerId);
  }

  /** Solo se cuelga lo propio: proyectos, obras publicadas sin vender y obras ganadas. */
  async addArtwork(ownerId: string, lotId: string): Promise<PersonalGallery> {
    assertUuid(lotId, 'La obra');
    if (!(await this.social.itemOf(ownerId, lotId))) {
      throw DomainError.forbidden('Solo puedes colgar obras tuyas: tus proyectos, lo que publicaste sin vender y lo que ganaste.');
    }
    const lot = await this.catalog.snapshot(lotId);
    if (!lot) {
      throw DomainError.notFound('Obra no encontrada');
    }
    await hang(this.galleries, ownerId, lot);
    return this.galleries.mine(ownerId);
  }

  async removeArtwork(ownerId: string, lotId: string): Promise<PersonalGallery> {
    const gallery = await this.owned(ownerId);
    await this.galleries.removeArtwork(gallery.id, lotId);
    return this.galleries.mine(ownerId);
  }

  async placeArtwork(
    ownerId: string,
    lotId: string,
    patch: { posX?: number; posY?: number; posZ?: number; rotY?: number; scale?: number; support?: string },
  ): Promise<PersonalGallery> {
    const gallery = await this.owned(ownerId);
    const current = gallery.artworks.find((artwork) => artwork.lotId === lotId);
    if (!current) {
      throw DomainError.notFound('La obra no está en tu galería');
    }
    await this.galleries.moveArtwork(current.id, placeArtwork(current, patch));
    return this.galleries.mine(ownerId);
  }

  private async owned(ownerId: string): Promise<PersonalGallery> {
    const gallery = await this.galleries.find(ownerId);
    if (!gallery) {
      throw DomainError.notFound('Todavía no tienes galería.');
    }
    return gallery;
  }
}

/** Galeria social: obras propias y ganadas, seguimientos y actividad. */
export class SocialUseCases {
  constructor(
    private readonly galleries: GalleryRepository,
    private readonly social: SocialStore,
    private readonly identity: IdentityPort,
    private readonly clock: Clock,
  ) {}

  async items(ownerId: string, viewerId: string | null): Promise<GalleryItem[]> {
    assertUuid(ownerId, 'El usuario');
    const items = await this.social.itemsOf(ownerId);
    return items.filter((item) => canViewItem(item, viewerId));
  }

  async follow(followerId: string, followeeId: string): Promise<void> {
    assertUuid(followeeId, 'El usuario');
    if (followerId === followeeId) {
      throw DomainError.invalid('No puedes seguirte a ti mismo');
    }
    const name = await this.identity.displayName(followeeId);
    if (name === null) {
      throw DomainError.notFound('Usuario no encontrado');
    }
    if (!(await this.galleries.follow(followerId, followeeId))) {
      return;
    }
    await this.social.upsertActivity(`follow:${followerId}:${followeeId}`, {
      actorId: followerId,
      verb: 'FOLLOW',
      objectType: 'USER',
      objectId: followeeId,
      visibility: 'PUBLIC',
      summary: `Siguió a ${name}`,
      createdAt: this.clock.now(),
    });
  }

  feed(viewerId: string): Promise<Activity[]> {
    return this.social.feed(viewerId, FEED_LIMIT);
  }
}

/**
 * Reacciones a eventos de otros servicios. El orden es comprobar, aplicar y
 * registrar: como los documentos tienen ids deterministas, un fallo entre el
 * efecto y el registro solo repite una escritura idempotente.
 */
export class GalleryEventHandlers {
  constructor(
    private readonly galleries: GalleryRepository,
    private readonly social: SocialStore,
    private readonly catalog: CatalogPort,
    private readonly clock: Clock,
  ) {}

  /**
   * LotCreated: la obra es de su autor. Un proyecto propio llega con la
   * visibilidad que eligio y se cuelga en su sala, que es para lo que existe.
   */
  async lotCreated(event: {
    eventId: string;
    lotId: string;
    sellerId: string;
    title: string;
    artistName: string | null;
    personal: boolean;
    visibility: Visibility;
  }): Promise<void> {
    await this.once(event.eventId, 'catalog.LotCreated', async () => {
      const source = event.personal ? 'PROYECTO' : 'PROPIA';
      await this.social.upsertItem(itemId(source, event.lotId, event.sellerId), {
        ownerId: event.sellerId,
        lotId: event.lotId,
        source,
        // Una obra del catalogo es privada en la galeria hasta que se publica.
        visibility: event.personal ? event.visibility : 'PRIVATE',
        title: event.title,
        artistName: event.artistName,
        imageKeys: [],
        acquiredAt: this.clock.now(),
      });
      if (event.personal) {
        const lot = await this.catalog.snapshot(event.lotId);
        if (lot) {
          await hang(this.galleries, event.sellerId, lot);
        }
      }
    });
  }

  /** LotSubmitted: un proyecto propio que pasa al catalogo deja de ser PROYECTO y se oculta mientras se audita. */
  async lotSubmitted(event: { eventId: string; lotId: string }): Promise<void> {
    await this.once(event.eventId, 'catalog.LotSubmitted', async () => {
      for (const item of await this.social.itemsOfLot(event.lotId)) {
        if (item.source === 'PROYECTO') {
          await this.social.updateItem(item.ownerId, event.lotId, { source: 'PROPIA', visibility: 'PRIVATE' });
        }
      }
    });
  }

  /** LotVisibilityChanged: el autor mostro u oculto su proyecto propio en la galeria publica. */
  async lotVisibilityChanged(event: { eventId: string; lotId: string; ownerId: string; visibility: Visibility }): Promise<void> {
    await this.once(event.eventId, 'catalog.LotVisibilityChanged', async () => {
      const item = await this.social.itemOf(event.ownerId, event.lotId);
      if (item?.source === 'PROYECTO') {
        await this.social.updateItem(event.ownerId, event.lotId, { visibility: event.visibility });
      }
    });
  }

  /**
   * AuctionClosed con ganador: la obra cambia de dueno. Sale de la galeria y de
   * la sala del autor, entra en las del ganador y se publica la actividad.
   */
  async auctionClosed(event: { eventId: string; lotId: string; sellerId: string; winnerId: string | null; buyNow?: boolean }): Promise<void> {
    const winnerId = event.winnerId;
    if (!winnerId) {
      return;
    }
    await this.once(event.eventId, 'auction.AuctionClosed', async () => {
      const lot = await this.catalog.snapshot(event.lotId);
      if (!lot) {
        return;
      }
      const now = this.clock.now();
      if (event.sellerId && event.sellerId !== winnerId) {
        await this.social.removeItem(event.sellerId, lot.lotId);
        const sellerRoom = await this.galleries.find(event.sellerId);
        if (sellerRoom) {
          await this.galleries.removeArtwork(sellerRoom.id, lot.lotId);
        }
      }
      await this.social.upsertItem(itemId('GANADA', lot.lotId, winnerId), {
        ownerId: winnerId,
        lotId: lot.lotId,
        source: 'GANADA',
        visibility: 'PRIVATE',
        title: lot.title,
        artistName: lot.artistName,
        imageKeys: lot.imageKeys,
        acquiredAt: now,
      });
      await hang(this.galleries, winnerId, lot);
      // Una compra inmediata se cuenta distinto en el feed que una victoria por tiempo.
      await this.social.upsertActivity(`win:${event.eventId}`, {
        actorId: winnerId,
        verb: event.buyNow === true ? 'BUY_NOW' : 'WIN',
        objectType: 'LOT',
        objectId: lot.lotId,
        visibility: 'PUBLIC',
        summary: event.buyNow === true ? `Compró ${lot.title} al instante` : `Ganó ${lot.title}`,
        createdAt: now,
      });
    });
  }

  private async once(eventId: string, eventType: string, effect: () => Promise<void>): Promise<void> {
    if (!eventId) {
      throw DomainError.invalid('El evento no trae event_id');
    }
    if (await this.galleries.seen(eventId)) {
      return;
    }
    await effect();
    await this.galleries.recordEvent(eventId, eventType);
  }
}
