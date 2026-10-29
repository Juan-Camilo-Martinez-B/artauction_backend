import type { ChannelCredentials } from '@grpc/grpc-js';
import { auctionHandlersV1, auditEventsV1, catalogHandlersV1, commonV1, notificationHandlersV1 } from '@artauction/contracts';
import type { OutboxDelivery, OutboxMessage } from '@artauction/platform';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import { AUDIT_EVENTS } from '../../internal/domain/verdict';

export interface ConsumerEndpoints {
  catalog: string;
  auction: string;
  notification: string;
}

const PRODUCER = 'audit-service';
const DEADLINE_MS = 5_000;

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function integer(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

/** AuditCompleted del outbox a su mensaje de artauction.audit.events.v1. */
export function auditCompletedMessage(message: OutboxMessage): auditEventsV1.AuditCompleted {
  const payload = message.payload;
  return auditEventsV1.AuditCompleted.fromPartial({
    metadata: commonV1.EventMetadata.fromPartial({ eventId: message.id, occurredAt: message.occurredAt, producer: PRODUCER }),
    lotId: text(payload, 'lotId'),
    sellerId: text(payload, 'sellerId'),
    title: text(payload, 'title'),
    verdict:
      text(payload, 'verdict') === 'APROBADO'
        ? auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED
        : auditEventsV1.AuditVerdict.AUDIT_VERDICT_MANUAL_REVIEW,
    score: integer(payload, 'score'),
    priceMin: integer(payload, 'priceMin'),
    priceMax: integer(payload, 'priceMax'),
    critical: payload['critical'] === true,
    rationale: text(payload, 'rationale'),
  });
}

/**
 * AuditCompleted va a catalog (estado y precios), auction (programa la sala si
 * se aprobo) y notification (aviso al vendedor). Notification sigue en el
 * servidor gRPC legado del monolito hasta F8: solo cambia su URL.
 */
export function auditOutboxRoutes(
  endpoints: ConsumerEndpoints,
  channel: ChannelCredentials,
  tokens: ServiceTokenProvider,
): { routes: Map<string, OutboxDelivery[]>; close: () => void } {
  const catalog = new catalogHandlersV1.CatalogEventHandlerServiceClient(endpoints.catalog, channel);
  const auction = new auctionHandlersV1.AuctionEventHandlerServiceClient(endpoints.auction, channel);
  const notification = new notificationHandlersV1.NotificationEventHandlerServiceClient(endpoints.notification, channel);
  const options = async () => ({ deadlineMs: DEADLINE_MS, authorization: await tokens.authorization() });

  const routes = new Map<string, OutboxDelivery[]>([
    [
      AUDIT_EVENTS.completed,
      [
        async (message) => {
          await invoke(catalog.handleAuditCompleted.bind(catalog), { event: auditCompletedMessage(message) }, await options());
        },
        async (message) => {
          await invoke(auction.handleAuditCompleted.bind(auction), { event: auditCompletedMessage(message) }, await options());
        },
        async (message) => {
          await invoke(notification.handleAuditCompleted.bind(notification), { event: auditCompletedMessage(message) }, await options());
        },
      ],
    ],
  ]);

  return {
    routes,
    close: () => {
      for (const client of [catalog, auction, notification]) {
        client.close();
      }
    },
  };
}
