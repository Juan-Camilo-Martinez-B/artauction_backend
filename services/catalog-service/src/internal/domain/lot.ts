import { DomainError } from '@artauction/platform';
import { CLOSED_STATUSES, PUBLIC_STATUSES, type LotStatus } from './lot-status';

export type Visibility = 'PUBLIC' | 'PRIVATE';
export type RepresentationKind = 'TWO_D' | 'THREE_D' | 'OTHER';
export type ActorRole = 'USER' | 'SELLER' | 'ADMIN';

export interface Actor {
  userId: string;
  role: ActorRole;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  active: boolean;
}

export interface LotImage {
  id: string;
  objectKey: string;
  position: number;
  perceptualHash: string | null;
  createdAt: Date;
}

/**
 * Obra del catalogo. Las cantidades decimales (medidas y precios) viajan como
 * texto para no perder precision: el dominio no hace aritmetica con ellas.
 */
export interface Lot {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  artistName: string | null;
  creationYear: number | null;
  materials: string;
  widthCm: string | null;
  heightCm: string | null;
  depthCm: string | null;
  provenance: string | null;
  representationKind: RepresentationKind | null;
  status: LotStatus;
  visibility: Visibility;
  authenticityScore: number | null;
  suggestedPriceMin: string | null;
  suggestedPriceMax: string | null;
  currency: string;
  createdAt: Date;
  images: LotImage[];
  categories: Array<{ isPrimary: boolean; category: Category }>;
}

export function canViewLot(lot: Pick<Lot, 'visibility' | 'sellerId'>, viewerId: string | null): boolean {
  return lot.visibility === 'PUBLIC' || (viewerId !== null && viewerId === lot.sellerId);
}

export function isListedPublicly(lot: Pick<Lot, 'visibility' | 'status'>): boolean {
  return lot.visibility === 'PUBLIC' && PUBLIC_STATUSES.includes(lot.status);
}

export function assertCanSell(actor: Actor): void {
  if (actor.role !== 'SELLER' && actor.role !== 'ADMIN') {
    throw DomainError.forbidden('Solo un vendedor puede publicar obras');
  }
}

/** El vendedor solo modifica sus obras y solo mientras no esten cerradas. */
export function assertOwnedAndOpen(lot: Lot | null, actor: Actor): Lot {
  if (!lot || lot.sellerId !== actor.userId) {
    throw DomainError.notFound('Obra no encontrada');
  }
  if (CLOSED_STATUSES.includes(lot.status)) {
    throw DomainError.invalid('El lote esta cerrado');
  }
  return lot;
}

export interface NewLot {
  title: string;
  description: string;
  artistName: string | null;
  creationYear: number | null;
  materials: string;
  categorySlug: string;
  representationKind: RepresentationKind;
  widthCm: string;
  heightCm: string;
  depthCm: string | null;
  provenance: string | null;
}

const DECIMAL = /^\d{1,4}(\.\d{1,2})?$/;

function measure(label: string, value: string): string {
  const trimmed = value.trim();
  const number = Number(trimmed);
  if (!DECIMAL.test(trimmed) || number < 0.1 || number > 2000) {
    throw DomainError.invalid(`${label} debe estar entre 0.1 y 2000 cm con hasta dos decimales.`);
  }
  return trimmed;
}

function text(label: string, value: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw DomainError.invalid(`${label} debe tener entre ${String(min)} y ${String(max)} caracteres.`);
  }
  return trimmed;
}

function optionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Valida y normaliza el alta de una obra con las mismas reglas que la ficha del frontend. */
export function parseNewLot(input: {
  title: string;
  description: string;
  artistName?: string | null;
  creationYear?: number | null;
  materials: string;
  categorySlug: string;
  representationKind: RepresentationKind | null;
  widthCm: string;
  heightCm: string;
  depthCm?: string | null;
  provenance?: string | null;
}): NewLot {
  if (input.representationKind === null) {
    throw DomainError.invalid('Indica si la obra es plana o tridimensional.');
  }
  if (input.creationYear != null && (!Number.isInteger(input.creationYear) || input.creationYear < 1 || input.creationYear > 2100)) {
    throw DomainError.invalid('El ano de creacion no es valido.');
  }
  const depth = optionalText(input.depthCm);
  if (input.representationKind === 'THREE_D' && depth === null) {
    throw DomainError.invalid('Un objeto tridimensional necesita profundidad.');
  }
  const provenance = optionalText(input.provenance);
  if (provenance !== null && provenance.length < 3) {
    throw DomainError.invalid('La procedencia debe tener al menos 3 caracteres.');
  }
  return {
    title: text('El titulo', input.title, 3, 200),
    description: text('La descripcion', input.description, 10, 5000),
    artistName: optionalText(input.artistName),
    creationYear: input.creationYear ?? null,
    materials: text('Los materiales', input.materials, 2, 300),
    categorySlug: text('La categoria', input.categorySlug, 2, 80),
    representationKind: input.representationKind,
    widthCm: measure('El ancho', input.widthCm),
    heightCm: measure('El alto', input.heightCm),
    depthCm: depth === null ? null : measure('La profundidad', depth),
    provenance,
  };
}

const STORED_KEY = /^lots\/[0-9a-f-]{36}\/[\w.-]+$/i;

/**
 * URL con la que el navegador ve una imagen: una URL https externa tal cual, o
 * una clave del bucket resuelta contra la base publica de medios. Cualquier
 * otra cosa no se publica.
 */
export function imageUrl(objectKey: string, mediaBaseUrl: string): string | null {
  const external = publicImageUrl(objectKey);
  if (external !== null) {
    return external;
  }
  const key = objectKey.trim();
  return STORED_KEY.test(key) ? `${mediaBaseUrl.replace(/\/+$/, '')}/${key}` : null;
}

/**
 * Solo una clave que ya es una URL https sin credenciales se publica como
 * imagen externa.
 */
export function publicImageUrl(objectKey: string): string | null {
  const key = objectKey.trim();
  if (!key.toLowerCase().startsWith('https://')) {
    return null;
  }
  try {
    const url = new URL(key);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : null;
  } catch {
    return null;
  }
}
