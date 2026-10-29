import { walletHandlersV1, type commonV1 } from '@artauction/contracts';
import { DomainError, type StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type {
  ConfirmBidHold,
  ReleaseAuctionHolds,
  ReleaseBidderHold,
  SettleClosedAuction,
} from '../../internal/application/use-cases';

export interface WalletEventUseCases {
  confirm: ConfirmBidHold;
  releaseBidder: ReleaseBidderHold;
  settle: SettleClosedAuction;
  releaseAuction: ReleaseAuctionHolds;
}

const PRODUCERS = ['auction-service'];

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

/** Recibe los eventos de subasta que entrega el outbox de auction-service. */
export function walletEventsGrpcService(
  useCases: WalletEventUseCases,
  callers: CallerResolver,
  logger: StructuredLogger,
): walletHandlersV1.WalletEventHandlerServiceServer {
  return {
    handleBidAccepted: unary(logger, 'HandleBidAccepted', async (request, context) => {
      callers.service(context, PRODUCERS);
      const event = required(request.event);
      await useCases.confirm.execute({ eventId: eventId(event.metadata), reservationId: event.reservationId });
      return walletHandlersV1.HandleBidAcceptedResponse.fromPartial({});
    }),

    handleBidWithdrawn: unary(logger, 'HandleBidWithdrawn', async (request, context) => {
      callers.service(context, PRODUCERS);
      const event = required(request.event);
      await useCases.releaseBidder.execute({
        eventId: eventId(event.metadata),
        auctionId: event.auctionId,
        bidderId: event.bidderId,
      });
      return walletHandlersV1.HandleBidWithdrawnResponse.fromPartial({});
    }),

    handleAuctionClosed: unary(logger, 'HandleAuctionClosed', async (request, context) => {
      callers.service(context, PRODUCERS);
      const event = required(request.event);
      await useCases.settle.execute({
        eventId: eventId(event.metadata),
        auctionId: event.auctionId,
        winnerId: event.winnerId === '' ? null : event.winnerId,
        sellerId: event.sellerId,
        amount: event.amount,
      });
      return walletHandlersV1.HandleAuctionClosedResponse.fromPartial({});
    }),

    handleAuctionRescheduled: unary(logger, 'HandleAuctionRescheduled', async (request, context) => {
      callers.service(context, PRODUCERS);
      const event = required(request.event);
      await useCases.releaseAuction.execute({ eventId: eventId(event.metadata), auctionId: event.auctionId });
      return walletHandlersV1.HandleAuctionRescheduledResponse.fromPartial({});
    }),
  };
}
