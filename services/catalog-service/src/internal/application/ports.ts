import type { DomainEvent } from '@artauction/platform';
import type { Category, Lot, LotImage, NewLot, RepresentationKind, Visibility } from '../domain/lot';
import type { LotStatus } from '../domain/lot-status';

export type LotSort = 'recent' | 'title' | 'score';

export interface PublicLotQuery {
  text: string | null;
  categorySlug: string | null;
  representation: RepresentationKind | null;
  sort: LotSort;
  page: number;
  pageSize: number;
}

export interface LotPatch {
  visibility?: Visibility;
  authenticityScore?: number;
  suggestedPriceMin?: string;
  suggestedPriceMax?: string;
}

export interface LotRepository {
  listPublic(query: PublicLotQuery): Promise<{ lots: Lot[]; total: number }>;
  relatedPublic(lotId: string, limit: number): Promise<Lot[]>;
  findById(lotId: string): Promise<Lot | null>;
  findByIds(lotIds: readonly string[]): Promise<Lot[]>;
  findActiveCategory(slug: string): Promise<Category | null>;
  listActiveCategories(): Promise<Category[]>;
  /** Crea la obra en BORRADOR y guarda los eventos en la misma transaccion. */
  create(sellerId: string, lot: NewLot, categoryId: string, events: (lot: Lot) => DomainEvent[]): Promise<Lot>;
  upsertImage(lotId: string, image: { objectKey: string; position: number; perceptualHash: string | null }): Promise<LotImage>;
  /**
   * Cambia el estado solo si el lote sigue en `from` (control optimista) y guarda
   * los eventos en la misma transaccion. Devuelve el lote actualizado o null.
   */
  transition(lotId: string, from: LotStatus, to: LotStatus, patch: LotPatch, events: (lot: Lot) => DomainEvent[]): Promise<Lot | null>;
  /**
   * Aplica un evento entrante una sola vez: registra `eventId` en el inbox y, si
   * es nuevo, ejecuta `apply` en la misma transaccion.
   */
  applyOnce(eventId: string, eventType: string, apply: (lots: LotTransitions) => Promise<void>): Promise<boolean>;
}

/** Operaciones disponibles dentro de la transaccion de un evento entrante. */
export interface LotTransitions {
  findById(lotId: string): Promise<Lot | null>;
  update(lotId: string, from: readonly LotStatus[], to: LotStatus, patch: LotPatch): Promise<boolean>;
}

export interface SignedUpload {
  uploadUrl: string;
  objectKey: string;
  expiresAt: Date;
}

export interface UploadSigner {
  sign(objectKey: string, contentType: string): Promise<SignedUpload>;
}

export interface TokenSource {
  /** Sufijo aleatorio corto para claves de objeto unicas. */
  next(): string;
}

export interface ImageHasher {
  hash(bytes: Uint8Array): Promise<string>;
}
