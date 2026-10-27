import { Body, Controller, Headers, Inject, Param, Post } from '@nestjs/common';
import { catalogV1 } from '@artauction/contracts';
import { invoke } from '@artauction/service-kit';
import { CATALOG_CLIENT } from '../../../clients/grpc-clients';
import type { GatewayConfig } from '../../../config';
import { GATEWAY_CONFIG } from '../tokens';
import { ResolveLotDto } from './catalog.dto';
import { lotJson } from './lot.presenter';

/** Revision manual de obras. El rol ADMIN lo comprueba catalog-service. */
@Controller('admin/lots')
export class AdminController {
  constructor(
    @Inject(CATALOG_CLIENT) private readonly catalog: catalogV1.CatalogServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  @Post(':id/resolve')
  async resolve(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: ResolveLotDto,
  ) {
    const response = await invoke(
      this.catalog.resolveManualReview.bind(this.catalog),
      catalogV1.ResolveManualReviewRequest.fromPartial({
        lotId: id,
        decision:
          body.verdict === 'APROBADO'
            ? catalogV1.ReviewDecision.REVIEW_DECISION_APPROVE
            : catalogV1.ReviewDecision.REVIEW_DECISION_RETURN_TO_DRAFT,
      }),
      { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization },
    );
    if (!response.lot) {
      throw new Error('catalog-service respondio sin obra');
    }
    return lotJson(response.lot);
  }
}
