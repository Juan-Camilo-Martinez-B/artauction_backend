import type { GalleryConfig, GalleryPreferences } from '../domain/gallery-design';
import type { Activity, Artwork, GalleryItem, PersonalGallery, PublicLot } from '../domain/gallery';

export interface GalleryPatch {
  preferences?: Record<string, unknown>;
  suggestedConfig?: Record<string, unknown>;
  appliedConfig?: Record<string, unknown>;
  customizationStatus?: PersonalGallery['customizationStatus'];
}

export interface GalleryRepository {
  /** Devuelve la galeria del duenio y la crea si no existe (carrera resuelta por la clave unica). */
  mine(ownerId: string): Promise<PersonalGallery>;
  find(ownerId: string): Promise<PersonalGallery | null>;
  update(galleryId: string, patch: GalleryPatch): Promise<void>;
  /** Cuelga la obra; si ya estaba, no hace nada. */
  addArtwork(galleryId: string, lotId: string, placement: Omit<Artwork, 'id' | 'lotId'>): Promise<void>;
  removeArtwork(galleryId: string, lotId: string): Promise<void>;
  moveArtwork(artworkId: string, placement: Omit<Artwork, 'id' | 'lotId'>): Promise<void>;
  /** Devuelve false si ya lo seguia. */
  follow(followerId: string, followeeId: string): Promise<boolean>;
  /** Registra un evento entrante; false si ya se habia procesado. */
  seen(eventId: string): Promise<boolean>;
  recordEvent(eventId: string, eventType: string): Promise<void>;
}

/**
 * Galeria social en Mongo. Los ids son deterministas (por obra y duenio, o por
 * evento): repetir una escritura no duplica documentos.
 */
export interface SocialStore {
  upsertItem(id: string, item: GalleryItem): Promise<void>;
  itemsOf(ownerId: string): Promise<GalleryItem[]>;
  upsertActivity(id: string, activity: Activity): Promise<void>;
  feed(viewerId: string, limit: number): Promise<Activity[]>;
}

export interface CatalogPort {
  /** Obra publica que se puede colgar; null si no existe o no es publica. */
  publicLot(lotId: string): Promise<PublicLot | null>;
  /** Ficha interna (ignora la visibilidad): la usa la galeria del ganador. */
  snapshot(lotId: string): Promise<PublicLot | null>;
}

export interface IdentityPort {
  /** Nombre visible del usuario; null si no existe. */
  displayName(userId: string): Promise<string | null>;
}

export interface GalleryDesigner {
  design(preferences: GalleryPreferences): Promise<GalleryConfig>;
}

export interface Clock {
  now(): Date;
}
