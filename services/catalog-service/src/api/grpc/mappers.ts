import { catalogV1, commonV1 } from '@artauction/contracts';
import { DomainError } from '@artauction/platform';
import { imageUrl, type Category, type Lot, type LotImage, type RepresentationKind } from '../../internal/domain/lot';
import type { LotStatus } from '../../internal/domain/lot-status';
import type { LotSort } from '../../internal/application/ports';
import type { ReviewDecision } from '../../internal/application/commands';

const STATUS_TO_PROTO: Readonly<Record<LotStatus, catalogV1.LotStatus>> = {
  BORRADOR: catalogV1.LotStatus.LOT_STATUS_BORRADOR,
  PENDIENTE_AUDITORIA: catalogV1.LotStatus.LOT_STATUS_PENDIENTE_AUDITORIA,
  APROBADO: catalogV1.LotStatus.LOT_STATUS_APROBADO,
  PUBLICADA: catalogV1.LotStatus.LOT_STATUS_PUBLICADA,
  REVISION_MANUAL: catalogV1.LotStatus.LOT_STATUS_REVISION_MANUAL,
  EN_SUBASTA: catalogV1.LotStatus.LOT_STATUS_EN_SUBASTA,
  CERRADO: catalogV1.LotStatus.LOT_STATUS_CERRADO,
  VENDIDA: catalogV1.LotStatus.LOT_STATUS_VENDIDA,
};

const REPRESENTATION_TO_PROTO: Readonly<Record<RepresentationKind, catalogV1.RepresentationKind>> = {
  TWO_D: catalogV1.RepresentationKind.REPRESENTATION_KIND_TWO_D,
  THREE_D: catalogV1.RepresentationKind.REPRESENTATION_KIND_THREE_D,
  OTHER: catalogV1.RepresentationKind.REPRESENTATION_KIND_OTHER,
};

export function representationFromProto(value: catalogV1.RepresentationKind): RepresentationKind | null {
  switch (value) {
    case catalogV1.RepresentationKind.REPRESENTATION_KIND_TWO_D:
      return 'TWO_D';
    case catalogV1.RepresentationKind.REPRESENTATION_KIND_THREE_D:
      return 'THREE_D';
    case catalogV1.RepresentationKind.REPRESENTATION_KIND_OTHER:
      return 'OTHER';
    default:
      return null;
  }
}

export function sortFromProto(value: catalogV1.LotSort): LotSort {
  switch (value) {
    case catalogV1.LotSort.LOT_SORT_TITLE:
      return 'title';
    case catalogV1.LotSort.LOT_SORT_SCORE:
      return 'score';
    default:
      return 'recent';
  }
}

export function decisionFromProto(value: catalogV1.ReviewDecision): ReviewDecision {
  switch (value) {
    case catalogV1.ReviewDecision.REVIEW_DECISION_APPROVE:
      return 'APPROVE';
    case catalogV1.ReviewDecision.REVIEW_DECISION_RETURN_TO_DRAFT:
      return 'RETURN_TO_DRAFT';
    default:
      throw DomainError.invalid('La decision de revision no es valida.');
  }
}

export function categoryToProto(category: Category): catalogV1.Category {
  return catalogV1.Category.fromPartial(category);
}

export function imageToProto(image: LotImage, mediaBaseUrl: string): catalogV1.LotImage {
  return catalogV1.LotImage.fromPartial({
    id: image.id,
    objectKey: image.objectKey,
    position: image.position,
    perceptualHash: image.perceptualHash ?? undefined,
    url: imageUrl(image.objectKey, mediaBaseUrl) ?? undefined,
  });
}

export function lotToProto(lot: Lot, mediaBaseUrl: string): catalogV1.Lot {
  return catalogV1.Lot.fromPartial({
    id: lot.id,
    sellerId: lot.sellerId,
    title: lot.title,
    description: lot.description,
    artistName: lot.artistName ?? undefined,
    creationYear: lot.creationYear ?? undefined,
    materials: lot.materials,
    widthCm: lot.widthCm ?? undefined,
    heightCm: lot.heightCm ?? undefined,
    depthCm: lot.depthCm ?? undefined,
    provenance: lot.provenance ?? undefined,
    representationKind: lot.representationKind
      ? REPRESENTATION_TO_PROTO[lot.representationKind]
      : catalogV1.RepresentationKind.REPRESENTATION_KIND_UNSPECIFIED,
    status: STATUS_TO_PROTO[lot.status],
    visibility: lot.visibility === 'PUBLIC' ? commonV1.Visibility.VISIBILITY_PUBLIC : commonV1.Visibility.VISIBILITY_PRIVATE,
    authenticityScore: lot.authenticityScore ?? undefined,
    suggestedPriceMin: lot.suggestedPriceMin ?? undefined,
    suggestedPriceMax: lot.suggestedPriceMax ?? undefined,
    currency: lot.currency,
    images: lot.images.map((image) => imageToProto(image, mediaBaseUrl)),
    categories: lot.categories.map((link) => ({ isPrimary: link.isPrimary, category: categoryToProto(link.category) })),
    createdAt: lot.createdAt,
  });
}
