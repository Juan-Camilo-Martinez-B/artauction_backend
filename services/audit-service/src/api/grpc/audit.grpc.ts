import { auditEventsV1, auditHandlersV1, auditV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { EnqueueAudit, GetLatestSummaries } from '../../internal/application/use-cases';

/** Consulta publica de resultados: la usa el gateway para componer la ficha. */
export function auditGrpcService(summaries: GetLatestSummaries, logger: StructuredLogger): auditV1.AuditServiceServer {
  return {
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
