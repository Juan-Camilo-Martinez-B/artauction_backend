import type { ChannelCredentials } from '@grpc/grpc-js';
import {
  auctionEventsV1,
  catalogHandlersV1,
  commonV1,
  galleryHandlersV1,
  notificationHandlersV1,
  walletHandlersV1,
} from '@artauction/contracts';
import type { OutboxDelivery, OutboxMessage } from '@artauction/platform';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import { AUCTION_EVENTS } from '../../internal/domain/auction';

export interface ConsumerEndpoints {
  wallet: string;
  catalog: string;
  gallery: string;
  notification: string;
}

const PRODUCER = 'auction-service';
const DEADLINE_MS = 5_000;

function metadata(message: OutboxMessage): commonV1.EventMetadata {
  return commonV1.EventMetadata.fromPartial({
    eventId: message.id,
    occurredAt: message.occurredAt,
    producer: PRODUCER,
  });
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
 * Traduce los eventos del outbox de auction a artauction.auction.events.v1 y
 * los entrega a cada consumidor. Gallery y notification siguen en el monolito
 * (servidor gRPC legado) hasta F8: solo cambia su URL.
 */
export function auctionOutboxRoutes(
  endpoints: ConsumerEndpoints,
  channel: ChannelCredentials,
  tokens: ServiceTokenProvider,
): { routes: Map<string, OutboxDelivery[]>; close: () => void } {
  const wallet = new walletHandlersV1.WalletEventHandlerServiceClient(endpoints.wallet, channel);
  const catalog = new catalogHandlersV1.CatalogEventHandlerServiceClient(endpoints.catalog, channel);
  const gallery = new galleryHandlersV1.GalleryEventHandlerServiceClient(endpoints.gallery, channel);
  const notification = new notificationHandlersV1.NotificationEventHandlerServiceClient(endpoints.notification, channel);
  const options = async () => ({ deadlineMs: DEADLINE_MS, authorization: await tokens.authorization() });

  const started = (message: OutboxMessage) =>
    auctionEventsV1.AuctionStarted.fromPartial({
      metadata: metadata(message),
      auctionId: text(message.payload, 'auctionId'),
      lotId: text(message.payload, 'lotId'),
    });
  const accepted = (message: OutboxMessage) =>
    auctionEventsV1.BidAccepted.fromPartial({
      metadata: metadata(message),
      auctionId: text(message.payload, 'auctionId'),
      bidId: text(message.payload, 'bidId'),
      bidderId: text(message.payload, 'bidderId'),
      amount: text(message.payload, 'amount'),
      endsAt: new Date(text(message.payload, 'endsAt')),
      extended: message.payload['extended'] === true,
      reservationId: text(message.payload, 'reservationId'),
      heldCoins: integer(message.payload, 'heldCoins'),
    });
  const withdrawn = (message: OutboxMessage) =>
    auctionEventsV1.BidWithdrawn.fromPartial({
      metadata: metadata(message),
      auctionId: text(message.payload, 'auctionId'),
      bidderId: text(message.payload, 'bidderId'),
    });
  const closed = (message: OutboxMessage) =>
    auctionEventsV1.AuctionClosed.fromPartial({
      metadata: metadata(message),
      auctionId: text(message.payload, 'auctionId'),
      lotId: text(message.payload, 'lotId'),
      sellerId: text(message.payload, 'sellerId'),
      winnerId: text(message.payload, 'winnerId'),
      amount: text(message.payload, 'amount'),
    });
  const rescheduled = (message: OutboxMessage) =>
    auctionEventsV1.AuctionRescheduled.fromPartial({
      metadata: metadata(message),
      auctionId: text(message.payload, 'auctionId'),
      lotId: text(message.payload, 'lotId'),
    });

  const routes = new Map<string, OutboxDelivery[]>([
    [
      AUCTION_EVENTS.started,
      [
        async (message) => {
          await invoke(catalog.handleAuctionStarted.bind(catalog), { event: started(message) }, await options());
        },
      ],
    ],
    [
      AUCTION_EVENTS.bidAccepted,
      [
        async (message) => {
          await invoke(wallet.handleBidAccepted.bind(wallet), { event: accepted(message) }, await options());
        },
      ],
    ],
    [
      AUCTION_EVENTS.bidWithdrawn,
      [
        async (message) => {
          await invoke(wallet.handleBidWithdrawn.bind(wallet), { event: withdrawn(message) }, await options());
        },
      ],
    ],
    [
      AUCTION_EVENTS.closed,
      [
        async (message) => {
          await invoke(wallet.handleAuctionClosed.bind(wallet), { event: closed(message) }, await options());
        },
        async (message) => {
          await invoke(catalog.handleAuctionClosed.bind(catalog), { event: closed(message) }, await options());
        },
        async (message) => {
          await invoke(gallery.handleAuctionClosed.bind(gallery), { event: closed(message) }, await options());
        },
        async (message) => {
          await invoke(notification.handleAuctionClosed.bind(notification), { event: closed(message) }, await options());
        },
      ],
    ],
    [
      AUCTION_EVENTS.rescheduled,
      [
        async (message) => {
          await invoke(wallet.handleAuctionRescheduled.bind(wallet), { event: rescheduled(message) }, await options());
        },
        async (message) => {
          await invoke(catalog.handleAuctionRescheduled.bind(catalog), { event: rescheduled(message) }, await options());
        },
      ],
    ],
  ]);

  return {
    routes,
    close: () => {
      for (const client of [wallet, catalog, gallery, notification]) {
        client.close();
      }
    },
  };
}
