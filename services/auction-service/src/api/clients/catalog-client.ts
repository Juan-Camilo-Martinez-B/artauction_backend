import { catalogV1 } from '@artauction/contracts';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import type { CatalogPort, LotSnapshot } from '../../internal/application/ports';

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

/** Implementa CatalogPort con la consulta interna BatchGetLotSnapshots. */
export class GrpcCatalogClient implements CatalogPort {
  constructor(
    private readonly catalog: catalogV1.CatalogServiceClient,
    private readonly tokens: ServiceTokenProvider,
  ) {}

  async lot(lotId: string): Promise<LotSnapshot | null> {
    const response = await invoke(this.catalog.batchGetLotSnapshots.bind(this.catalog), { lotIds: [lotId] }, {
      deadlineMs: 3_000,
      authorization: await this.tokens.authorization(),
    });
    const lot = response.lots[0];
    if (!lot) {
      return null;
    }
    return { lotId: lot.id, sellerId: lot.sellerId, title: lot.title, status: STATUS_NAMES.get(lot.status) ?? 'BORRADOR' };
  }
}
