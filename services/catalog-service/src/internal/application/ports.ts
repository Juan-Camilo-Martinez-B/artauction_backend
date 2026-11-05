import type { DomainEvent } from '@artauction/platform';
import type { Category, Lot, LotImage, LotModel, NewLot, RepresentationKind, Visibility } from '../domain/lot';
import type { LotStatus } from '../domain/lot-status';
import type { Locale, TranslatableTexts } from '../domain/translation';

export type LotSort = 'recent' | 'title' | 'score';

export interface PublicLotQuery {
  text: string | null;
  categorySlug: string | null;
  representation: RepresentationKind | null;
  sort: LotSort;
  page: number;
  pageSize: number;
}

/** Imagen de otra obra parecida a una de la obra auditada. */
export interface SimilarImage {
  lotId: string;
  sellerId: string;
  queryHash: string;
  matchedHash: string;
  distance: number;
}

/** Decision de un administrador que se guarda junto con la transicion. */
export interface NewLotReview {
  adminId: string;
  decision: 'APPROVE' | 'RETURN_TO_DRAFT' | 'REAUDIT';
  reason: string | null;
  priceMin: number | null;
  priceMax: number | null;
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
  /** Obras en un estado, la mas antigua primero. */
  listByStatus(status: LotStatus, limit: number): Promise<Lot[]>;
  /** Muestra al azar de obras publicadas y publicas con precio sugerido. */
  sampleAuctionable(limit: number): Promise<Lot[]>;
  /** Imagenes de otras obras a distancia de Hamming <= maxDistance de algun hash. */
  findSimilarImages(lotId: string, hashes: readonly string[], maxDistance: number): Promise<SimilarImage[]>;
  listActiveCategories(): Promise<Category[]>;
  /** Crea la obra en el estado inicial de su destino y guarda los eventos en la misma transaccion. */
  create(
    sellerId: string,
    lot: NewLot,
    categoryId: string,
    initial: { status: LotStatus; visibility: Visibility },
    events: (lot: Lot) => DomainEvent[],
  ): Promise<Lot>;
  /** Reemplaza la ficha de una obra que sigue editable (borrador o proyecto propio); null si cambio de estado. */
  update(lotId: string, lot: NewLot, categoryId: string): Promise<Lot | null>;
  /** Obras de un vendedor, la mas reciente primero. */
  listBySeller(sellerId: string, limit: number): Promise<Lot[]>;
  upsertImage(lotId: string, image: { objectKey: string; position: number; perceptualHash: string | null }): Promise<LotImage>;
  /** Registra o reemplaza el modelo 3D de la obra. */
  saveModel(lotId: string, model: Omit<LotModel, 'createdAt'>): Promise<LotModel>;
  removeModel(lotId: string): Promise<void>;
  /**
   * Cambia el estado solo si el lote sigue en `from` (control optimista) y guarda
   * los eventos en la misma transaccion. Devuelve el lote actualizado o null.
   */
  transition(
    lotId: string,
    from: LotStatus,
    to: LotStatus,
    patch: LotPatch,
    events: (lot: Lot) => DomainEvent[],
    review?: NewLotReview,
  ): Promise<Lot | null>;
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

/** Lee un archivo subido al bucket para validarlo; corta en `maxBytes`. */
export interface ModelReader {
  read(objectKey: string, maxBytes: number): Promise<Uint8Array>;
}

export interface TokenSource {
  /** Sufijo aleatorio corto para claves de objeto unicas. */
  next(): string;
}

export interface ImageHasher {
  hash(bytes: Uint8Array): Promise<string>;
}

/** Solicitud de traduccion tomada de la cola, con su lease. */
export interface TranslationJob {
  id: string;
  lotId: string;
  /** Huella del texto que habia que traducir al encolarla. */
  sourceHash: string;
  /** Intentos, contando el actual. */
  attempts: number;
}

/** Ficha tal como esta ahora, para decidir si la solicitud sigue vigente. */
export interface TranslationSource {
  texts: TranslatableTexts;
  visibility: Visibility;
}

/** Resultado del traductor: idioma detectado del original y sus traducciones. */
export interface TranslatedTexts {
  sourceLocale: Locale;
  model: string;
  translations: Array<{ locale: Locale; texts: TranslatableTexts }>;
}

/** Cola de traduccion y guardado de las traducciones. */
export interface TranslationStore {
  /** Encola las fichas publicas sin traduccion vigente ni intento previo de esa version. Devuelve cuantas. */
  enqueueStale(limit: number): Promise<number>;
  /** Toma la siguiente solicitud vencida con FOR UPDATE SKIP LOCKED y le pone un lease. */
  claimNext(leaseMs: number): Promise<TranslationJob | null>;
  sourceOf(lotId: string): Promise<TranslationSource | null>;
  /** Reemplaza las traducciones de la obra, guarda su idioma y cierra la solicitud, en una transaccion. */
  save(job: TranslationJob, sourceHash: string, result: TranslatedTexts): Promise<void>;
  /** Cierra una solicitud que ya no aplica (la ficha cambio o dejo de ser publica). */
  discard(jobId: string): Promise<void>;
  /** Registra un fallo: reintento en retryAt, o solicitud fallida si es null. */
  fail(jobId: string, error: string, retryAt: Date | null): Promise<void>;
}

/** Traductor de fichas (ai-service). */
export interface LotTranslator {
  translate(texts: TranslatableTexts): Promise<TranslatedTexts>;
}
