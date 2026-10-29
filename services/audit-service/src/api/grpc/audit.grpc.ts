import { auditEventsV1, auditHandlersV1, auditV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { EnqueueAudit, GetLatestSummaries, GetReviewReports } from '../../internal/application/use-cases';

const SEVERITY: Readonly<Record<'INFO' | 'WARNING' | 'CRITICAL', auditV1.ReviewSeverity>> = {
  INFO: auditV1.ReviewSeverity.REVIEW_SEVERITY_INFO,
  WARNING: auditV1.ReviewSeverity.REVIEW_SEVERITY_WARNING,
  CRITICAL: auditV1.ReviewSeverity.REVIEW_SEVERITY_CRITICAL,
};

/** Resumenes publicos para la ficha y expedientes de revision solo para ADMIN. */
export function auditGrpcService(
  useCases: { summaries: GetLatestSummaries; reviews: GetReviewReports },
  callers: CallerResolver,
  logger: StructuredLogger,
): auditV1.AuditServiceServer {
  const { summaries, reviews } = useCases;
  return {
    batchGetReviewReports: unary(logger, 'BatchGetReviewReports', async (request, context) => {
      const reports = await reviews.execute(callers.user(context), request.lotIds);
      return auditV1.BatchGetReviewReportsResponse.fromPartial({
        reports: reports.map((report) => ({
          lotId: report.lotId,
          summaryId: report.summaryId,
          score: report.score,
          decidedBy: report.decidedBy ?? '',
          modelName: report.modelName,
          createdAt: report.createdAt,
          findings: report.findings.map((finding) => ({ ...finding, severity: SEVERITY[finding.severity] })),
        })),
      });
    }),

    batchGetLatestSummaries: unary(logger, 'BatchGetLatestSummaries', async (request) => {
      const rows = await summaries.execute(request.lotIds);
      return auditV1.BatchGetLatestSummariesResponse.fromPartial({
        summaries: rows.map((row) => ({
          id: row.id,
          lotId: row.lotId,
          score: row.score,
          priceMin: row.priceMin.toFixed(2),
          priceMax: row.priceMax.toFixed(2),
          verdict:
            row.verdict === 'APROBADO'
              ? auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED
              : auditEventsV1.AuditVerdict.AUDIT_VERDICT_MANUAL_REVIEW,
          hasCriticalInconsistency: row.critical,
          modelName: row.modelName,
          promptVersion: row.promptVersion,
          createdAt: row.createdAt,
        })),
      });
    }),
  };
}

/** Eventos que consume audit-service. Solo catalog puede pedir una auditoria. */
export function auditEventsGrpcService(
  enqueue: EnqueueAudit,
  callers: CallerResolver,
  logger: StructuredLogger,
): auditHandlersV1.AuditEventHandlerServiceServer {
  return {
    handleLotSubmitted: unary(logger, 'HandleLotSubmitted', async (request, context) => {
      callers.service(context, ['catalog-service']);
      const event = request.event;
      if (event) {
        await enqueue.execute({ eventId: event.metadata?.eventId ?? '', lotId: event.lotId });
      }
      return auditHandlersV1.HandleLotSubmittedResponse.fromPartial({});
    }),
  };
}
