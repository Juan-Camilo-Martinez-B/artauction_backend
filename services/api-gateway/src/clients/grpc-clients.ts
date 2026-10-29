import { auctionV1, auditV1, catalogV1, galleryV1, identityV1, notificationV1, walletV1 } from '@artauction/contracts';
import { channelCredentials } from '@artauction/platform';
import type { GatewayConfig } from '../config';

export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');
export const CATALOG_CLIENT = Symbol('CATALOG_CLIENT');
export const AUCTION_CLIENT = Symbol('AUCTION_CLIENT');
export const AUDIT_CLIENT = Symbol('AUDIT_CLIENT');
export const WALLET_CLIENT = Symbol('WALLET_CLIENT');
export const GALLERY_CLIENT = Symbol('GALLERY_CLIENT');
export const NOTIFICATION_CLIENT = Symbol('NOTIFICATION_CLIENT');

const CHANNEL_OPTIONS = { 'grpc.keepalive_time_ms': 30_000 };

/** Un canal HTTP/2 persistente por servicio; grpc-js multiplexa las llamadas. */
export function createIdentityClient(config: GatewayConfig): identityV1.IdentityServiceClient {
  return new identityV1.IdentityServiceClient(config.IDENTITY_GRPC_URL, channelCredentials(config.tls), CHANNEL_OPTIONS);
}

export function createCatalogClient(config: GatewayConfig): catalogV1.CatalogServiceClient {
  return new catalogV1.CatalogServiceClient(config.CATALOG_GRPC_URL, channelCredentials(config.tls), CHANNEL_OPTIONS);
}

export function createAuctionClient(config: GatewayConfig): auctionV1.AuctionServiceClient {
  return new auctionV1.AuctionServiceClient(config.AUCTION_GRPC_URL, channelCredentials(config.tls), CHANNEL_OPTIONS);
}

export function createWalletClient(config: GatewayConfig): walletV1.WalletServiceClient {
  return new walletV1.WalletServiceClient(config.WALLET_GRPC_URL, channelCredentials(config.tls), CHANNEL_OPTIONS);
}

export function createAuditClient(config: GatewayConfig): auditV1.AuditServiceClient {
  return new auditV1.AuditServiceClient(config.AUDIT_GRPC_URL, channelCredentials(config.tls), CHANNEL_OPTIONS);
}

export function createGalleryClient(config: GatewayConfig): galleryV1.GalleryServiceClient {
  return new galleryV1.GalleryServiceClient(config.GALLERY_GRPC_URL, channelCredentials(config.tls), CHANNEL_OPTIONS);
}

export function createNotificationClient(config: GatewayConfig): notificationV1.NotificationServiceClient {
  return new notificationV1.NotificationServiceClient(config.NOTIFICATION_GRPC_URL, channelCredentials(config.tls), CHANNEL_OPTIONS);
}
