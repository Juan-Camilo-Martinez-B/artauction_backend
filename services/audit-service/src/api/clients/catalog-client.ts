import { catalogV1 } from '@artauction/contracts';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import type { LotSheet, SimilarImageMatch } from '../../internal/domain/dossier';
import type { CatalogPort } from '../../internal/application/ports';

const STATUS_NAMES: ReadonlyMap<catalogV1.LotStatus, string> = new Map([
  [catalogV1.LotStatus.LOT_STATUS_BORRADOR, 'BORRADOR'],
  [catalogV1.LotStatus.LOT_STATUS_PENDIENTE_AUDITORIA, 'PENDIENTE_AUDITORIA'],
  [catalogV1.LotStatus.LOT_STATUS_APROBADO, 'APROBADO'],
  [catalogV1.LotStatus.LOT_STATUS_PUBLICADA, 'PUBLICADA'],
  [catalogV1.LotStatus.LOT_STATUS_REVISION_MANUAL, 'REVISION_MANUAL'],
  [catalogV1.LotStatus.LOT_STATUS_EN_SUBASTA, 'EN_SUBASTA'],
  [catalogV1.LotStatus.LOT_STATUS_CERRADO, 'CERRADO'],
  [catalogV1.LotStatus.LOT_STATUS_VENDIDA, 'VENDIDA'],
]);

/** Distancia de Hamming maxima para considerar dos dHash la misma imagen. */
const DUPLICATE_DISTANCE = 6;
const DEADLINE_MS = 5_000;

function centimeters(value: string | undefined): number | null {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Implementa CatalogPort con las consultas internas de catalog-service. */
export class GrpcCatalogClient implements CatalogPort {
  constructor(
    private readonly catalog: catalogV1.CatalogServiceClient,
    private readonly tokens: ServiceTokenProvider,
  ) {}

  async lot(lotId: string): Promise<LotSheet | null> {
    const response = await invoke(this.catalog.batchGetLotSnapshots.bind(this.catalog), { lotIds: [lotId] }, await this.options());
    const lot = response.lots[0];
    if (!lot) {
      return null;
    }
    return {
      lotId: lot.id,
      sellerId: lot.sellerId,
      status: STATUS_NAMES.get(lot.status) ?? 'BORRADOR',
      title: lot.title,
      description: lot.description,
      artistName: lot.artistName ?? null,
      creationYear: lot.creationYear ?? null,
      materials: lot.materials,
      widthCm: centimeters(lot.widthCm),
      heightCm: centimeters(lot.heightCm),
      provenance: lot.provenance ?? '',
      images: [...lot.images]
        .sort((left, right) => left.position - right.position)
        .map((image) => ({ url: image.url ?? null, perceptualHash: image.perceptualHash ?? null })),
    };
  }

  async similarImages(lotId: string, hashes: readonly string[]): Promise<SimilarImageMatch[]> {
    const response = await invoke(
      this.catalog.findSimilarImages.bind(this.catalog),
      { lotId, perceptualHashes: [...hashes], maxDistance: DUPLICATE_DISTANCE },
      await this.options(),
    );
    return response.matches.map((match) => ({
      lotId: match.lotId,
      sellerId: match.sellerId,
      queryHash: match.queryHash,
      distance: match.distance,
    }));
  }

  private async options() {
    return { deadlineMs: DEADLINE_MS, authorization: await this.tokens.authorization() };
  }
}
