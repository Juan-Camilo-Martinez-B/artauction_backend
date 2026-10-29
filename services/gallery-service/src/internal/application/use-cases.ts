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
  placeArtwork,
  type Activity,
  type GalleryItem,
  type PersonalGallery,
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

  async addArtwork(ownerId: string, lotId: string): Promise<PersonalGallery> {
    assertUuid(lotId, 'La obra');
    const gallery = await this.galleries.mine(ownerId);
    const lot = await this.catalog.publicLot(lotId);
    if (!lot) {
      throw DomainError.notFound('Obra no encontrada');
    }
    await this.galleries.addArtwork(gallery.id, lotId, initialPlacement(gallery, lot));
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

  /** LotCreated: la obra entra en la galeria de su vendedor. */
  async lotCreated(event: { eventId: string; lotId: string; sellerId: string; title: string; artistName: string | null }): Promise<void> {
    await this.once(event.eventId, 'catalog.LotCreated', () =>
      this.social.upsertItem(`PROPIA:${event.lotId}:${event.sellerId}`, {
        ownerId: event.sellerId,
        lotId: event.lotId,
        source: 'PROPIA',
        visibility: 'PRIVATE',
        title: event.title,
        artistName: event.artistName,
        imageKeys: [],
        acquiredAt: this.clock.now(),
      }),
    );
  }

  /** AuctionClosed con ganador: la obra entra en su galeria y se publica la actividad. */
  async auctionClosed(event: { eventId: string; lotId: string; winnerId: string | null }): Promise<void> {
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
      await this.social.upsertItem(`GANADA:${lot.lotId}:${winnerId}`, {
        ownerId: winnerId,
        lotId: lot.lotId,
        source: 'GANADA',
        visibility: 'PRIVATE',
        title: lot.title,
        artistName: lot.artistName,
        imageKeys: lot.imageKeys,
        acquiredAt: now,
      });
      await this.social.upsertActivity(`win:${event.eventId}`, {
        actorId: winnerId,
        verb: 'WIN',
        objectType: 'LOT',
        objectId: lot.lotId,
        visibility: 'PUBLIC',
        summary: `Ganó ${lot.title}`,
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
