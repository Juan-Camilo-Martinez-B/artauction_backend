import { DomainError } from '@artauction/platform';
import type { GalleryConfig } from './gallery-design';

// Galeria 3D personal y galeria social. Las reglas son las mismas que tenia el
// monolito; aqui no se lee ningun dato de otro contexto.

export type CustomizationStatus = 'SIN_PERSONALIZAR' | 'PERSONALIZADA' | 'EDITADA';
export type Support = 'WALL' | 'PEDESTAL' | 'FLOOR' | 'PLATFORM' | 'NICHE';
export type ItemSource = 'PROPIA' | 'GANADA' | 'GRATUITA';
export type Visibility = 'PUBLIC' | 'PRIVATE';

export const SUPPORTS: readonly Support[] = ['WALL', 'PEDESTAL', 'FLOOR', 'PLATFORM', 'NICHE'];
const MAX_SCALE = 3;
const DEFAULT_ROOM_DEPTH = 10;

export interface Artwork {
  id: string;
  lotId: string;
  posX: number;
  posY: number;
  posZ: number;
  rotY: number;
  scale: number;
  support: Support;
}

export interface PersonalGallery {
  id: string;
  ownerId: string;
  name: string;
  customizationStatus: CustomizationStatus;
  preferences: Record<string, unknown>;
  suggestedConfig: Record<string, unknown> | null;
  appliedConfig: Record<string, unknown> | null;
  artworks: Artwork[];
}

export interface GalleryItem {
  ownerId: string;
  lotId: string | null;
  source: ItemSource;
  visibility: Visibility;
  title: string;
  artistName: string | null;
  imageKeys: string[];
  acquiredAt: Date;
}

export interface Activity {
  actorId: string;
  verb: 'PUBLISH' | 'BID' | 'WIN' | 'FOLLOW' | 'AUDIT';
  objectType: 'LOT' | 'AUCTION' | 'USER' | 'AUDIT';
  objectId: string;
  visibility: Visibility;
  summary: string;
  createdAt: Date;
}

/** Ficha minima de una obra publica, la que hace falta para colgarla. */
export interface PublicLot {
  lotId: string;
  title: string;
  artistName: string | null;
  representationKind: 'TWO_D' | 'THREE_D' | 'OTHER';
  imageKeys: string[];
}

export function isSupport(value: string): value is Support {
  return (SUPPORTS as readonly string[]).includes(value);
}

function roomDepth(config: Record<string, unknown> | null): number {
  const architecture = config?.['architecture'];
  if (typeof architecture !== 'object' || architecture === null) {
    return DEFAULT_ROOM_DEPTH;
  }
  const depth = (architecture as Record<string, unknown>)['roomDepth'];
  return typeof depth === 'number' ? depth : DEFAULT_ROOM_DEPTH;
}

/** Posicion inicial de una obra nueva: en fila de tres, en la pared del fondo o sobre pedestal. */
export function initialPlacement(gallery: PersonalGallery, lot: PublicLot): Omit<Artwork, 'id' | 'lotId'> {
  const column = gallery.artworks.length % 3;
  const threeD = lot.representationKind === 'THREE_D';
  return {
    posX: threeD ? -2 + column * 2 : -3.2 + column * 2.4,
    posY: threeD ? 0 : 1.55,
    posZ: threeD ? 0.4 : -(roomDepth(gallery.appliedConfig) / 2 - 0.08),
    rotY: 0,
    scale: 1,
    support: threeD ? 'PEDESTAL' : 'WALL',
  };
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Aplica un cambio de posicion validando soporte y escala. */
export function placeArtwork(
  current: Artwork,
  patch: { posX?: number; posY?: number; posZ?: number; rotY?: number; scale?: number; support?: string },
): Omit<Artwork, 'id' | 'lotId'> {
  const support = patch.support ?? current.support;
  if (!isSupport(support)) {
    throw DomainError.invalid('Soporte no admitido.');
  }
  const scale = finite(patch.scale, current.scale);
  if (scale <= 0 || scale > MAX_SCALE) {
    throw DomainError.invalid('La escala está fuera de rango.');
  }
  return {
    posX: finite(patch.posX, current.posX),
    posY: finite(patch.posY, current.posY),
    posZ: finite(patch.posZ, current.posZ),
    rotY: finite(patch.rotY, current.rotY),
    scale,
    support,
  };
}

/** Hay cambios manuales si la sala aplicada difiere de la ultima propuesta. */
export function hasManualChanges(gallery: PersonalGallery, differ: (left: unknown, right: unknown) => boolean): boolean {
  return gallery.customizationStatus === 'EDITADA' && differ(gallery.appliedConfig, gallery.suggestedConfig);
}

export function canViewItem(item: { visibility: Visibility; ownerId: string }, viewerId: string | null): boolean {
  return item.visibility === 'PUBLIC' || (viewerId !== null && viewerId === item.ownerId);
}

export function asConfigRecord(config: GalleryConfig): Record<string, unknown> {
  return { ...config };
}
