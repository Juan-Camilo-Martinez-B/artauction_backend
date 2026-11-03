import type { ChannelCredentials } from '@grpc/grpc-js';
import { auctionHandlersV1, auditHandlersV1, catalogEventsV1, commonV1, galleryHandlersV1, notificationHandlersV1 } from '@artauction/contracts';
import type { OutboxDelivery, OutboxMessage } from '@artauction/platform';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import { CATALOG_EVENTS } from '../../internal/domain/events';

export interface ConsumerEndpoints {
  gallery: string;
  audit: string;
  auction: string;
  notification: string;
}

const PRODUCER = 'catalog-service';
const DEADLINE_MS = 5_000;

function metadata(message: OutboxMessage): commonV1.EventMetadata {
  return commonV1.EventMetadata.fromPartial({ eventId: message.id, occurredAt: message.occurredAt, producer: PRODUCER });
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function visibility(payload: Record<string, unknown>): commonV1.Visibility {
  return payload['visibility'] === 'PUBLIC' ? commonV1.Visibility.VISIBILITY_PUBLIC : commonV1.Visibility.VISIBILITY_PRIVATE;
}

function integer(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Traduce cada evento del outbox (JSON de dominio) al mensaje protobuf de
 * artauction.catalog.events.v1 y lo entrega al handler de cada consumidor.
 */
export function catalogOutboxRoutes(
  endpoints: ConsumerEndpoints,
  channel: ChannelCredentials,
  tokens: ServiceTokenProvider,
): { routes: Map<string, OutboxDelivery[]>; close: () => void } {
  const gallery = new galleryHandlersV1.GalleryEventHandlerServiceClient(endpoints.gallery, channel);
  const audit = new auditHandlersV1.AuditEventHandlerServiceClient(endpoints.audit, channel);
  const auction = new auctionHandlersV1.AuctionEventHandlerServiceClient(endpoints.auction, channel);
  const notification = new notificationHandlersV1.NotificationEventHandlerServiceClient(endpoints.notification, channel);

  const toGallery: OutboxDelivery = async (message) => {
    const event = catalogEventsV1.LotCreated.fromPartial({
      metadata: metadata(message),
      lotId: text(message.payload, 'lotId'),
      sellerId: text(message.payload, 'sellerId'),
      title: text(message.payload, 'title'),
      artistName: text(message.payload, 'artistName') || undefined,
      personal: message.payload['personal'] === true,
      visibility: visibility(message.payload),
    });
    await invoke(gallery.handleLotCreated.bind(gallery), { event }, {
      deadlineMs: DEADLINE_MS,
      authorization: await tokens.authorization(),
    });
  };

  // Un proyecto propio que pasa al catalogo deja de ser PROYECTO en la galeria.
  const submittedToGallery: OutboxDelivery = async (message) => {
    const event = catalogEventsV1.LotSubmitted.fromPartial({ metadata: metadata(message), lotId: text(message.payload, 'lotId') });
    await invoke(gallery.handleLotSubmitted.bind(gallery), { event }, {
      deadlineMs: DEADLINE_MS,
      authorization: await tokens.authorization(),
    });
  };

  const visibilityToGallery: OutboxDelivery = async (message) => {
    const event = catalogEventsV1.LotVisibilityChanged.fromPartial({
      metadata: metadata(message),
      lotId: text(message.payload, 'lotId'),
      ownerId: text(message.payload, 'ownerId'),
      visibility: visibility(message.payload),
    });
    await invoke(gallery.handleLotVisibilityChanged.bind(gallery), { event }, {
      deadlineMs: DEADLINE_MS,
      authorization: await tokens.authorization(),
    });
  };

  const toAudit: OutboxDelivery = async (message) => {
    const event = catalogEventsV1.LotSubmitted.fromPartial({
      metadata: metadata(message),
      lotId: text(message.payload, 'lotId'),
    });
    await invoke(audit.handleLotSubmitted.bind(audit), { event }, {
      deadlineMs: DEADLINE_MS,
      authorization: await tokens.authorization(),
    });
  };

  const toAuction: OutboxDelivery = async (message) => {
    const event = catalogEventsV1.LotPublished.fromPartial({
      metadata: metadata(message),
      lotId: text(message.payload, 'lotId'),
      sellerId: text(message.payload, 'sellerId'),
      title: text(message.payload, 'title'),
      score: integer(message.payload, 'score'),
      priceMin: integer(message.payload, 'priceMin'),
      priceMax: integer(message.payload, 'priceMax'),
    });
    await invoke(auction.handleLotPublished.bind(auction), { event }, {
      deadlineMs: DEADLINE_MS,
      authorization: await tokens.authorization(),
    });
  };

  const toNotification: OutboxDelivery = async (message) => {
    const event = catalogEventsV1.LotReturnedToDraft.fromPartial({
      metadata: metadata(message),
      lotId: text(message.payload, 'lotId'),
      sellerId: text(message.payload, 'sellerId'),
      title: text(message.payload, 'title'),
      reason: text(message.payload, 'reason'),
    });
    await invoke(notification.handleLotReturnedToDraft.bind(notification), { event }, {
      deadlineMs: DEADLINE_MS,
      authorization: await tokens.authorization(),
    });
  };

  return {
    routes: new Map([
      [CATALOG_EVENTS.lotCreated, [toGallery]],
      [CATALOG_EVENTS.lotSubmitted, [toAudit, submittedToGallery]],
      [CATALOG_EVENTS.lotPublished, [toAuction]],
      [CATALOG_EVENTS.lotReturnedToDraft, [toNotification]],
      [CATALOG_EVENTS.lotVisibilityChanged, [visibilityToGallery]],
    ]),
    close: () => {
      gallery.close();
      audit.close();
      auction.close();
      notification.close();
    },
  };
}
