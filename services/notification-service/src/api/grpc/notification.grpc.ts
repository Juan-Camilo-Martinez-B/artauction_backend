import { auditEventsV1, notificationHandlersV1, notificationV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { Notification } from '../../internal/domain/notification';
import type { ListNotifications, NotificationEvents } from '../../internal/application/use-cases';

/** Un map de proto no admite null: los valores nulos se omiten y el gateway los repone. */
function toProto(notification: Notification): notificationV1.Notification {
  const payload = Object.fromEntries(
    Object.entries(notification.payload).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  return notificationV1.Notification.fromPartial({
    id: notification.id,
    userId: notification.userId,
    kind: notification.kind,
    payload,
    createdAt: notification.createdAt,
    readAt: notification.readAt ?? undefined,
  });
}

export function notificationGrpcService(
  list: ListNotifications,
  callers: CallerResolver,
  logger: StructuredLogger,
): notificationV1.NotificationServiceServer {
  return {
    listNotifications: unary(logger, 'ListNotifications', async (_request, context) =>
      notificationV1.ListNotificationsResponse.fromPartial({
        notifications: (await list.execute(callers.user(context).userId)).map(toProto),
      }),
    ),
  };
}

/** Eventos que generan avisos: resultado de auditoria y cierre de subasta. */
export function notificationEventsGrpcService(
  events: NotificationEvents,
  callers: CallerResolver,
  logger: StructuredLogger,
): notificationHandlersV1.NotificationEventHandlerServiceServer {
  return {
    handleAuditCompleted: unary(logger, 'HandleAuditCompleted', async (request, context) => {
      callers.service(context, ['audit-service']);
      const event = request.event;
      if (event) {
        await events.auditCompleted({
          eventId: event.metadata?.eventId ?? '',
          lotId: event.lotId,
          sellerId: event.sellerId,
          verdict: event.verdict === auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED ? 'APROBADO' : 'REVISION_MANUAL',
        });
      }
      return notificationHandlersV1.HandleAuditCompletedResponse.fromPartial({});
    }),
    handleAuctionClosed: unary(logger, 'HandleAuctionClosed', async (request, context) => {
      callers.service(context, ['auction-service']);
      const event = request.event;
      if (event) {
        await events.auctionClosed({
          eventId: event.metadata?.eventId ?? '',
          auctionId: event.auctionId,
          lotId: event.lotId,
          sellerId: event.sellerId,
          winnerId: event.winnerId || null,
          amount: event.amount,
        });
      }
      return notificationHandlersV1.HandleAuctionClosedResponse.fromPartial({});
    }),
  };
}
