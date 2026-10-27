import { auctionV1, auditEventsV1, catalogV1, commonV1, type auditV1 } from '@artauction/contracts';

// Convierte los mensajes de los servicios a la forma JSON que el frontend ya
// consume (la misma que devolvia el monolito con Prisma).

const LOT_STATUS: ReadonlyMap<catalogV1.LotStatus, string> = new Map([
  [catalogV1.LotStatus.LOT_STATUS_BORRADOR, 'BORRADOR'],
  [catalogV1.LotStatus.LOT_STATUS_PENDIENTE_AUDITORIA, 'PENDIENTE_AUDITORIA'],
  [catalogV1.LotStatus.LOT_STATUS_APROBADO, 'APROBADO'],
  [catalogV1.LotStatus.LOT_STATUS_PUBLICADA, 'PUBLICADA'],
  [catalogV1.LotStatus.LOT_STATUS_REVISION_MANUAL, 'REVISION_MANUAL'],
  [catalogV1.LotStatus.LOT_STATUS_EN_SUBASTA, 'EN_SUBASTA'],
  [catalogV1.LotStatus.LOT_STATUS_CERRADO, 'CERRADO'],
  [catalogV1.LotStatus.LOT_STATUS_VENDIDA, 'VENDIDA'],
]);

const REPRESENTATION: ReadonlyMap<catalogV1.RepresentationKind, string> = new Map([
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_TWO_D, 'TWO_D'],
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_THREE_D, 'THREE_D'],
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_OTHER, 'OTHER'],
]);

const AUCTION_STATUS: ReadonlyMap<auctionV1.AuctionStatus, string> = new Map([
  [auctionV1.AuctionStatus.AUCTION_STATUS_PROGRAMADA, 'PROGRAMADA'],
  [auctionV1.AuctionStatus.AUCTION_STATUS_ACTIVA, 'ACTIVA'],
  [auctionV1.AuctionStatus.AUCTION_STATUS_CERRADA, 'CERRADA'],
]);

export interface AuctionCardJson {
  id: string;
  status: string;
  currentPrice: string;
  startsAt: string | null;
  endsAt: string | null;
  saleDescription: string | null;
  currency: string;
}

export interface CategoryJson {
  id: string;
  name: string;
  slug: string;
  description: string;
  active: boolean;
}

export function categoryJson(category: catalogV1.Category): CategoryJson {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    active: category.active,
  };
}

export function imageJson(lotId: string, image: catalogV1.LotImage) {
  return {
    id: image.id,
    lotId,
    objectKey: image.objectKey,
    position: image.position,
    perceptualHash: image.perceptualHash ?? null,
    url: image.url ?? null,
  };
}

export function auctionJson(summary: auctionV1.AuctionSummary): AuctionCardJson {
  return {
    id: summary.auctionId,
    status: AUCTION_STATUS.get(summary.status) ?? 'PROGRAMADA',
    currentPrice: summary.currentPrice,
    startsAt: summary.startsAt?.toISOString() ?? null,
    endsAt: summary.endsAt?.toISOString() ?? null,
    saleDescription: summary.saleDescription ?? null,
    currency: summary.currency,
  };
}

export function auditJson(summary: auditV1.AuditSummary) {
  return {
    id: summary.id,
    lotId: summary.lotId,
    score: summary.score,
    priceMin: summary.priceMin,
    priceMax: summary.priceMax,
    verdict: summary.verdict === auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED ? 'APROBADO' : 'REVISION_MANUAL',
    hasCriticalInconsistency: summary.hasCriticalInconsistency,
    modelName: summary.modelName,
    promptVersion: summary.promptVersion,
    createdAt: summary.createdAt?.toISOString() ?? null,
  };
}

export function lotJson(lot: catalogV1.Lot, auction: auctionV1.AuctionSummary | undefined | null = null) {
  return {
    id: lot.id,
    sellerId: lot.sellerId,
    title: lot.title,
    description: lot.description,
    artistName: lot.artistName ?? null,
    creationYear: lot.creationYear ?? null,
    materials: lot.materials,
    widthCm: lot.widthCm ?? null,
    heightCm: lot.heightCm ?? null,
    depthCm: lot.depthCm ?? null,
    provenance: lot.provenance ?? null,
    representationKind: REPRESENTATION.get(lot.representationKind) ?? null,
    status: LOT_STATUS.get(lot.status) ?? 'BORRADOR',
    visibility: lot.visibility === commonV1.Visibility.VISIBILITY_PUBLIC ? 'PUBLIC' : 'PRIVATE',
    authenticityScore: lot.authenticityScore ?? null,
    suggestedPriceMin: lot.suggestedPriceMin ?? null,
    suggestedPriceMax: lot.suggestedPriceMax ?? null,
    currency: lot.currency,
    createdAt: lot.createdAt?.toISOString() ?? null,
    images: lot.images.map((image) => imageJson(lot.id, image)),
    categories: lot.categories.flatMap((link) =>
      link.category
        ? [{ lotId: lot.id, categoryId: link.category.id, isPrimary: link.isPrimary, category: categoryJson(link.category) }]
        : [],
    ),
    auction: auction ? auctionJson(auction) : null,
  };
}

export const REPRESENTATION_FROM_JSON: Readonly<Record<string, catalogV1.RepresentationKind>> = {
  TWO_D: catalogV1.RepresentationKind.REPRESENTATION_KIND_TWO_D,
  THREE_D: catalogV1.RepresentationKind.REPRESENTATION_KIND_THREE_D,
  OTHER: catalogV1.RepresentationKind.REPRESENTATION_KIND_OTHER,
};

export const SORT_FROM_JSON: Readonly<Record<string, catalogV1.LotSort>> = {
  recent: catalogV1.LotSort.LOT_SORT_RECENT,
  title: catalogV1.LotSort.LOT_SORT_TITLE,
  score: catalogV1.LotSort.LOT_SORT_SCORE,
};
