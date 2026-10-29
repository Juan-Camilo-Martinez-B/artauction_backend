import { DomainError } from '@artauction/platform';
import { canViewLot, isListedPublicly, type Category, type Lot, type RepresentationKind } from '../domain/lot';
import type { LotRepository, LotSort, SimilarImage } from './ports';

const MAX_PAGE_SIZE = 60;
const MAX_BATCH = 100;

export class ListPublicLots {
  constructor(private readonly lots: LotRepository) {}

  async execute(input: {
    text?: string;
    categorySlug?: string;
    representation?: RepresentationKind;
    sort?: LotSort;
    page?: number;
    pageSize?: number;
  }): Promise<{ lots: Lot[]; total: number; page: number; pageSize: number }> {
    const page = clampInt(input.page, 1, 1, 10_000);
    const pageSize = clampInt(input.pageSize, 12, 1, MAX_PAGE_SIZE);
    const text = input.text?.trim() ?? '';
    const { lots, total } = await this.lots.listPublic({
      text: text.length > 0 ? text.slice(0, 120) : null,
      categorySlug: input.categorySlug?.trim() || null,
      representation: input.representation ?? null,
      sort: input.sort ?? 'recent',
      page,
      pageSize,
    });
    return { lots, total, page, pageSize };
  }
}

export class ListCategories {
  constructor(private readonly lots: LotRepository) {}

  execute(): Promise<Category[]> {
    return this.lots.listActiveCategories();
  }
}

export class GetRelatedLots {
  constructor(private readonly lots: LotRepository) {}

  async execute(lotId: string): Promise<Lot[]> {
    const lot = await this.lots.findById(lotId);
    if (!lot || lot.visibility !== 'PUBLIC') {
      return [];
    }
    return this.lots.relatedPublic(lotId, 4);
  }
}

export class GetLotForViewer {
  constructor(private readonly lots: LotRepository) {}

  async execute(lotId: string, viewerId: string | null): Promise<Lot> {
    const lot = await this.lots.findById(lotId);
    // Una obra privada responde igual que una inexistente: no se revela que existe.
    if (!lot || !canViewLot(lot, viewerId)) {
      throw DomainError.notFound('Obra no encontrada');
    }
    return lot;
  }
}

export class BatchGetPublicLots {
  constructor(private readonly lots: LotRepository) {}

  async execute(lotIds: readonly string[]): Promise<Lot[]> {
    const found = await this.lots.findByIds(uniqueIds(lotIds));
    return found.filter(isListedPublicly);
  }
}

/** Para servicios internos: devuelve la obra sin filtrar por visibilidad. */
export class BatchGetLotSnapshots {
  constructor(private readonly lots: LotRepository) {}

  execute(lotIds: readonly string[]): Promise<Lot[]> {
    return this.lots.findByIds(uniqueIds(lotIds));
  }
}

const PERCEPTUAL_HASH = /^[0-9a-f]{16}$/;
const MAX_HASHES = 20;
const MAX_HAMMING_DISTANCE = 16;

/**
 * Busca imagenes reutilizadas en otras obras. La usa audit-service para el
 * expediente de evidencias; los hashes son datos de catalog y no salen de aqui.
 */
export class FindSimilarImages {
  constructor(private readonly lots: LotRepository) {}

  async execute(lotId: string, hashes: readonly string[], maxDistance: number): Promise<SimilarImage[]> {
    const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    if (unique.length > MAX_HASHES || unique.some((hash) => !PERCEPTUAL_HASH.test(hash))) {
      throw DomainError.invalid(`Se esperan hasta ${String(MAX_HASHES)} hashes perceptuales de 16 caracteres hexadecimales.`);
    }
    if (!Number.isInteger(maxDistance) || maxDistance < 0 || maxDistance > MAX_HAMMING_DISTANCE) {
      throw DomainError.invalid(`La distancia maxima va de 0 a ${String(MAX_HAMMING_DISTANCE)}.`);
    }
    return unique.length === 0 ? [] : this.lots.findSimilarImages(lotId, unique, maxDistance);
  }
}

function uniqueIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BATCH) {
    throw DomainError.invalid(`Se piden como maximo ${String(MAX_BATCH)} obras por llamada.`);
  }
  return unique;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value === 0) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
