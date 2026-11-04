import { DomainError } from '@artauction/platform';
import type { GalleryConfig } from './gallery-design';

// Galeria 3D personal y galeria social. Las reglas son las mismas que tenia el
// monolito; aqui no se lee ningun dato de otro contexto.

export type CustomizationStatus = 'SIN_PERSONALIZAR' | 'PERSONALIZADA' | 'EDITADA';
export type Support = 'WALL' | 'PEDESTAL' | 'FLOOR' | 'PLATFORM' | 'NICHE';
/**
 * Por que una obra es de alguien: PROYECTO (proyecto propio sin auditar),
 * PROPIA (obra suya en el catalogo, aun sin vender) o GANADA (ganada en
 * subasta). Al venderse, la obra deja de ser del autor y pasa al ganador.
 */
export type ItemSource = 'PROYECTO' | 'PROPIA' | 'GANADA';
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
  lotId: string;
  source: ItemSource;
  visibility: Visibility;
  title: string;
  artistName: string | null;
  imageKeys: string[];
  acquiredAt: Date;
}

export interface Activity {
  actorId: string;
  verb: 'PUBLISH' | 'BID' | 'WIN' | 'BUY_NOW' | 'FOLLOW' | 'AUDIT';
  objectType: 'LOT' | 'AUCTION' | 'USER' | 'AUDIT';
  objectId: string;
  visibility: Visibility;
  summary: string;
  createdAt: Date;
}

/**
 * Id determinista del item: repetir un evento no duplica la fila. Lo del autor
 * (proyecto u obra del catalogo) comparte id, asi pasar al catalogo no crea otra.
 */
export function itemId(source: ItemSource, lotId: string, ownerId: string): string {
  return `${source === 'GANADA' ? 'GANADA' : 'PROPIA'}:${lotId}:${ownerId}`;
}

/**
 * Copia fija de la ficha de una obra ganada. Al venderse, el catalogo deja de
 * publicarla; la galeria de quien la compro la conserva como certificado.
 */
export interface PurchasedSheet {
  /**
   * La ficha tal como la publicaba catalog al comprarse: su mensaje protobuf
   * (artauction.catalog.v1.Lot) en base64. Copia exacta que la galeria no interpreta.
   */
  lot: string;
  /** Precio pagado; null en compras anteriores a la ficha guardada. */
  pricePaid: string | null;
  /** Si fue por compra inmediata; null si no se sabe. */
  buyNow: boolean | null;
  acquiredAt: Date;
}

/** El precio pagado solo lo ve la duena de la obra. */
export function sheetForViewer(sheet: PurchasedSheet, ownerId: string, viewerId: string | null): PurchasedSheet {
  return viewerId === ownerId ? sheet : { ...sheet, pricePaid: null };
}

/** Ficha minima de una obra, la que hace falta para colgarla. */
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

interface RoomSize {
  width: number;
  depth: number;
}

const DEFAULT_ROOM_WIDTH = 12;
/** Ancho de cada hueco de pared y separacion de los pedestales, en metros. */
const WALL_SLOT = 2;
const CORNER_MARGIN = 0.9;
const EYE_LEVEL = 1.55;
const WALL_OFFSET = 0.04;
const OBJECT_WALL_CLEARANCE = 2.6;
const OBJECT_SPACING = 2.4;

function roomSize(config: Record<string, unknown> | null): RoomSize {
  const architecture = config?.['architecture'];
  const values = typeof architecture === 'object' && architecture !== null ? (architecture as Record<string, unknown>) : {};
  const width = values['roomWidth'];
  const depth = values['roomDepth'];
  return {
    width: typeof width === 'number' ? width : DEFAULT_ROOM_WIDTH,
    depth: typeof depth === 'number' ? depth : DEFAULT_ROOM_DEPTH,
  };
}

type WallSide = 'back' | 'left' | 'right' | 'front';
const WALL_ORDER: readonly WallSide[] = ['back', 'left', 'right', 'front'];

// Geometria de las paredes: la misma de src/lib/gallery/layout.ts en el frontend.
function wallPoint(side: WallSide, t: number, room: RoomSize): { x: number; z: number; rotY: number } {
  switch (side) {
    case 'back':
      return { x: t, z: -room.depth / 2 + WALL_OFFSET, rotY: 0 };
    case 'left':
      return { x: -room.width / 2 + WALL_OFFSET, z: -t, rotY: Math.PI / 2 };
    case 'right':
      return { x: room.width / 2 - WALL_OFFSET, z: t, rotY: -Math.PI / 2 };
    case 'front':
      return { x: -t, z: room.depth / 2 - WALL_OFFSET, rotY: Math.PI };
  }
}

function wallSideOf(rotY: number): WallSide {
  const turns = ((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4;
  return (['back', 'left', 'front', 'right'] as const)[turns] ?? 'back';
}

function wallCoordinate(artwork: Pick<Artwork, 'posX' | 'posZ' | 'rotY'>): number {
  switch (wallSideOf(artwork.rotY)) {
    case 'back':
      return artwork.posX;
    case 'left':
      return -artwork.posZ;
    case 'right':
      return artwork.posZ;
    case 'front':
      return -artwork.posX;
  }
}

/** Huecos de pared en orden de recorrido, centrados en cada pared. */
function wallSlots(room: RoomSize): Array<{ side: WallSide; t: number }> {
  const slots: Array<{ side: WallSide; t: number }> = [];
  for (const side of WALL_ORDER) {
    const length = side === 'back' || side === 'front' ? room.width : room.depth;
    const count = Math.max(1, Math.floor((length - 2 * CORNER_MARGIN) / WALL_SLOT));
    for (let index = 0; index < count; index += 1) {
      slots.push({ side, t: (index - (count - 1) / 2) * WALL_SLOT });
    }
  }
  return slots;
}

/** Reticula de pedestales del centro hacia afuera (como objectGrid del frontend). */
function floorSlots(room: RoomSize): Array<{ x: number; z: number }> {
  const columns = Math.max(1, Math.floor(Math.max(0, room.width - 2 * OBJECT_WALL_CLEARANCE) / OBJECT_SPACING) + 1);
  const rows = Math.max(1, Math.floor(Math.max(0, room.depth - 2 * OBJECT_WALL_CLEARANCE) / OBJECT_SPACING) + 1);
  const points: Array<{ x: number; z: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push({ x: (column - (columns - 1) / 2) * OBJECT_SPACING, z: (row - (rows - 1) / 2) * OBJECT_SPACING });
    }
  }
  return points.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z) || a.z - b.z || a.x - b.x);
}

/**
 * Posicion inicial de una obra nueva: el primer hueco libre. Las obras murales
 * recorren las paredes (fondo, izquierda, derecha, entrada) en huecos de 2 m;
 * los objetos van en pedestales en una reticula en el centro. Un hueco esta
 * ocupado si ya hay una obra cerca, asi se respetan las piezas que el duenio
 * movio o retiro. Si todo esta ocupado, la obra va al primer hueco y el
 * boton "Organizar" de la sala reparte todo segun las medidas reales.
 */
export function initialPlacement(gallery: PersonalGallery, lot: PublicLot): Omit<Artwork, 'id' | 'lotId'> {
  const room = roomSize(gallery.appliedConfig);
  if (lot.representationKind === 'THREE_D') {
    const objects = gallery.artworks.filter((artwork) => artwork.support !== 'WALL');
    const slots = floorSlots(room);
    const free = slots.find((slot) => objects.every((artwork) => Math.hypot(artwork.posX - slot.x, artwork.posZ - slot.z) >= OBJECT_SPACING / 2));
    const point = free ?? slots[0] ?? { x: 0, z: 0 };
    return { posX: point.x, posY: 0, posZ: point.z, rotY: 0, scale: 1, support: 'PEDESTAL' };
  }
  const hung = gallery.artworks.filter((artwork) => artwork.support === 'WALL');
  const slots = wallSlots(room);
  const free = slots.find((slot) =>
    hung.every((artwork) => wallSideOf(artwork.rotY) !== slot.side || Math.abs(wallCoordinate(artwork) - slot.t) >= WALL_SLOT / 2),
  );
  const slot = free ?? slots[0] ?? { side: 'back' as const, t: 0 };
  const point = wallPoint(slot.side, slot.t, room);
  return { posX: point.x, posY: EYE_LEVEL, posZ: point.z, rotY: point.rotY, scale: 1, support: 'WALL' };
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
