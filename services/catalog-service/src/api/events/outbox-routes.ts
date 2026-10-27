import type { ChannelCredentials } from '@grpc/grpc-js';
import { auctionHandlersV1, auditHandlersV1, catalogEventsV1, commonV1, galleryHandlersV1 } from '@artauction/contracts';
import type { OutboxDelivery, OutboxMessage } from '@artauction/platform';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import { CATALOG_EVENTS } from '../../internal/domain/events';

export interface ConsumerEndpoints {
  gallery: string;
  audit: string;
  auction: string;
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

  const toGallery: OutboxDelivery = async (message) => {
    const event = catalogEventsV1.LotCreated.fromPartial({
      metadata: metadata(message),
      lotId: text(message.payload, 'lotId'),
      sellerId: text(message.payload, 'sellerId'),
      title: text(message.payload, 'title'),
      artistName: text(message.payload, 'artistName') || undefined,
    });
    await invoke(gallery.handleLotCreated.bind(gallery), { event }, {
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

  return {
    routes: new Map([
      [CATALOG_EVENTS.lotCreated, [toGallery]],
      [CATALOG_EVENTS.lotSubmitted, [toAudit]],
      [CATALOG_EVENTS.lotPublished, [toAuction]],
    ]),
    close: () => {
      gallery.close();
      audit.close();
      auction.close();
    },
  };
}
