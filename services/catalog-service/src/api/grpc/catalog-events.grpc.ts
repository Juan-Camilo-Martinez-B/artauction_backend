import { auditEventsV1, catalogHandlersV1, type commonV1 } from '@artauction/contracts';
import { DomainError, type StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type {
  ApplyAuditVerdict,
  MarkLotInAuction,
  MarkLotSold,
  RepublishUnsoldLot,
} from '../../internal/application/event-handlers';

export interface CatalogEventUseCases {
  applyAuditVerdict: ApplyAuditVerdict;
  markInAuction: MarkLotInAuction;
  markSold: MarkLotSold;
  republish: RepublishUnsoldLot;
}

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

/** Recibe los eventos que entregan los outbox de audit y auction. */
export function catalogEventsGrpcService(
  useCases: CatalogEventUseCases,
  callers: CallerResolver,
  logger: StructuredLogger,
): catalogHandlersV1.CatalogEventHandlerServiceServer {
  return {
    handleAuditCompleted: unary(logger, 'HandleAuditCompleted', async (request, context) => {
      callers.service(context, ['audit-service']);
      const event = required(request.event);
      await useCases.applyAuditVerdict.execute({
        eventId: eventId(event.metadata),
        lotId: event.lotId,
        approved: event.verdict === auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED,
        score: event.score,
        priceMin: event.priceMin,
        priceMax: event.priceMax,
      });
      return catalogHandlersV1.HandleAuditCompletedResponse.fromPartial({});
    }),

    handleAuctionStarted: unary(logger, 'HandleAuctionStarted', async (request, context) => {
      callers.service(context, ['auction-service']);
      const event = required(request.event);
      await useCases.markInAuction.execute({ eventId: eventId(event.metadata), lotId: event.lotId });
      return catalogHandlersV1.HandleAuctionStartedResponse.fromPartial({});
    }),

    handleAuctionClosed: unary(logger, 'HandleAuctionClosed', async (request, context) => {
      callers.service(context, ['auction-service']);
      const event = required(request.event);
      await useCases.markSold.execute({ eventId: eventId(event.metadata), lotId: event.lotId });
      return catalogHandlersV1.HandleAuctionClosedResponse.fromPartial({});
    }),

    handleAuctionRescheduled: unary(logger, 'HandleAuctionRescheduled', async (request, context) => {
      callers.service(context, ['auction-service']);
      const event = required(request.event);
      await useCases.republish.execute({ eventId: eventId(event.metadata), lotId: event.lotId });
      return catalogHandlersV1.HandleAuctionRescheduledResponse.fromPartial({});
    }),
  };
}
