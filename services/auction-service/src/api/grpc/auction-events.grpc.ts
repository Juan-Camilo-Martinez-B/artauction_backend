import { auctionHandlersV1, auditEventsV1, type commonV1 } from '@artauction/contracts';
import { DomainError, type StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { ScheduleApprovedLot } from '../../internal/application/scheduling';

function eventId(metadata: commonV1.EventMetadata | undefined): string {
  if (!metadata?.eventId) {
    throw DomainError.invalid('El evento no trae event_id');
  }
  return metadata.eventId;
}

function required<T>(event: T | undefined): T {
  if (event === undefined) {
    throw DomainError.invalid('Falta el evento');
  }
  return event;
}

/** Eventos que programan subastas: auditoria aprobada y revision manual aprobada. */
export function auctionEventsGrpcService(
  schedule: ScheduleApprovedLot,
  callers: CallerResolver,
  logger: StructuredLogger,
): auctionHandlersV1.AuctionEventHandlerServiceServer {
  return {
    handleAuditCompleted: unary(logger, 'HandleAuditCompleted', async (request, context) => {
      callers.service(context, ['audit-service']);
      const event = required(request.event);
      // Una obra en revision manual no se subasta hasta que un admin la apruebe.
      if (event.verdict === auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED) {
        await schedule.execute({
          eventId: eventId(event.metadata),
          eventType: 'audit.AuditCompleted',
          lotId: event.lotId,
          sellerId: event.sellerId,
          title: event.title,
          score: event.score,
          priceMin: event.priceMin,
          priceMax: event.priceMax,
          rationale: event.rationale,
        });
      }
      return auctionHandlersV1.HandleAuditCompletedResponse.fromPartial({});
    }),

    handleLotPublished: unary(logger, 'HandleLotPublished', async (request, context) => {
      callers.service(context, ['catalog-service']);
      const event = required(request.event);
      await schedule.execute({
        eventId: eventId(event.metadata),
        eventType: 'catalog.LotPublished',
        lotId: event.lotId,
        sellerId: event.sellerId,
        title: event.title,
        score: event.score,
        priceMin: event.priceMin,
        priceMax: event.priceMax,
        rationale: 'Aprobada en revision manual.',
      });
      return auctionHandlersV1.HandleLotPublishedResponse.fromPartial({});
    }),
  };
}
