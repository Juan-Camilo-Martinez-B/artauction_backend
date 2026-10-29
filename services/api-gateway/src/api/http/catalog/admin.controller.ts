import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { auditV1, catalogV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { invoke } from '@artauction/service-kit';
import { AUDIT_CLIENT, CATALOG_CLIENT } from '../../../clients/grpc-clients';
import type { GatewayConfig } from '../../../config';
import { GATEWAY_CONFIG, GATEWAY_LOGGER } from '../tokens';
import { ResolveLotDto } from './catalog.dto';
import { lotJson } from './lot.presenter';

const SEVERITY: ReadonlyMap<auditV1.ReviewSeverity, string> = new Map([
  [auditV1.ReviewSeverity.REVIEW_SEVERITY_INFO, 'INFO'],
  [auditV1.ReviewSeverity.REVIEW_SEVERITY_WARNING, 'WARNING'],
  [auditV1.ReviewSeverity.REVIEW_SEVERITY_CRITICAL, 'CRITICAL'],
]);

function reviewJson(report: auditV1.ReviewReport) {
  return {
    summaryId: report.summaryId,
    score: report.score,
    decidedBy: report.decidedBy || null,
    modelName: report.modelName,
    createdAt: report.createdAt?.toISOString() ?? null,
    findings: report.findings.map((finding) => ({
      code: finding.code,
      severity: SEVERITY.get(finding.severity) ?? 'INFO',
      message: finding.message,
      evidence: finding.evidence.map((item) => ({ code: item.code, value: item.value })),
    })),
  };
}

/**
 * Revision manual de obras. El rol ADMIN lo comprueban catalog-service y
 * audit-service con el token reenviado.
 */
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(CATALOG_CLIENT) private readonly catalog: catalogV1.CatalogServiceClient,
    @Inject(AUDIT_CLIENT) private readonly audits: auditV1.AuditServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(GATEWAY_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /**
   * Cola de revision: cada obra con el expediente de su ultima auditoria. Si
   * audit-service no responde, la obra sale con `audit: null` y se puede
   * resolver igual.
   */
  @Get('reviews')
  async reviews(@Headers('authorization') authorization: string | undefined) {
    const options = { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization };
    const queue = await invoke(this.catalog.listReviewQueue.bind(this.catalog), { limit: 50 }, options);
    let reports = new Map<string, auditV1.ReviewReport>();
    if (queue.lots.length > 0) {
      try {
        const response = await invoke(this.audits.batchGetReviewReports.bind(this.audits), { lotIds: queue.lots.map((lot) => lot.id) }, options);
        reports = new Map(response.reports.map((report) => [report.lotId, report]));
      } catch (error) {
        this.logger.warn(`cola de revision sin expedientes: ${error instanceof Error ? error.message : String(error)}`, 'admin');
      }
    }
    return queue.lots.map((lot) => {
      const report = reports.get(lot.id);
      return { lot: lotJson(lot), audit: report ? reviewJson(report) : null };
    });
  }

  @Post('lots/:id/resolve')
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
