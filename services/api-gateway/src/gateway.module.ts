import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Client } from '@grpc/grpc-js';
import { TokenVerifier, type StructuredLogger } from '@artauction/platform';
import type { auctionV1 } from '@artauction/contracts';
import { AuctionsController } from './api/http/auctions/auctions.controller';
import { AuthController } from './api/http/auth/auth.controller';
import { AdminController } from './api/http/catalog/admin.controller';
import { CatalogController } from './api/http/catalog/catalog.controller';
import { HealthController } from './api/http/health.controller';
import { GATEWAY_CONFIG, GATEWAY_LOGGER, LIVE_ROOM } from './api/http/tokens';
import { LiveRoom } from './api/live/live-room';
import { grpcWatchSource } from './api/live/room-streams';
import {
  AUCTION_CLIENT,
  AUDIT_CLIENT,
  CATALOG_CLIENT,
  createAuctionClient,
  createAuditClient,
  createCatalogClient,
  createIdentityClient,
  createGalleryClient,
  createNotificationClient,
  createWalletClient,
  GALLERY_CLIENT,
  IDENTITY_CLIENT,
  NOTIFICATION_CLIENT,
  WALLET_CLIENT,
} from './clients/grpc-clients';
import { WalletController } from './api/http/wallet/wallet.controller';
import { NotificationsController, PersonalGalleryController, SocialController } from './api/http/gallery/gallery.controller';
import type { GatewayConfig } from './config';

@Module({})
export class GatewayModule implements OnApplicationShutdown {
  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: Client,
    @Inject(CATALOG_CLIENT) private readonly catalog: Client,
    @Inject(AUCTION_CLIENT) private readonly auction: Client,
    @Inject(AUDIT_CLIENT) private readonly audit: Client,
    @Inject(WALLET_CLIENT) private readonly wallet: Client,
    @Inject(GALLERY_CLIENT) private readonly gallery: Client,
    @Inject(NOTIFICATION_CLIENT) private readonly notification: Client,
    @Inject(LIVE_ROOM) private readonly liveRoom: LiveRoom | null,
  ) {}

  static register(config: GatewayConfig, logger: StructuredLogger): DynamicModule {
    return {
      module: GatewayModule,
      imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }] })],
      controllers: [AuthController, CatalogController, AdminController, WalletController, AuctionsController, PersonalGalleryController, SocialController, NotificationsController, HealthController],
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        { provide: GATEWAY_LOGGER, useValue: logger },
        { provide: IDENTITY_CLIENT, useFactory: () => createIdentityClient(config) },
        { provide: CATALOG_CLIENT, useFactory: () => createCatalogClient(config) },
        { provide: AUCTION_CLIENT, useFactory: () => createAuctionClient(config) },
        { provide: AUDIT_CLIENT, useFactory: () => createAuditClient(config) },
        { provide: WALLET_CLIENT, useFactory: () => createWalletClient(config) },
        { provide: GALLERY_CLIENT, useFactory: () => createGalleryClient(config) },
        { provide: NOTIFICATION_CLIENT, useFactory: () => createNotificationClient(config) },
        {
          provide: LIVE_ROOM,
          inject: [AUCTION_CLIENT],
          useFactory: (auctions: auctionV1.AuctionServiceClient) => createLiveRoom(config, logger, auctions),
        },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    };
  }

  onApplicationShutdown(): void {
    this.liveRoom?.close();
    for (const client of [this.identity, this.catalog, this.auction, this.audit, this.wallet, this.gallery, this.notification]) {
      client.close();
    }
  }
}

/** Sin clave publica no hay forma de autenticar sockets: la sala queda apagada. */
function createLiveRoom(config: GatewayConfig, logger: StructuredLogger, auctions: auctionV1.AuctionServiceClient): LiveRoom | null {
  const keyPath = config.JWT_PUBLIC_KEY_PATH.trim();
  if (keyPath.length === 0) {
    logger.warn('JWT_PUBLIC_KEY_PATH vacio: la sala en vivo queda desactivada', 'live-room');
    return null;
  }
  return new LiveRoom(auctions, grpcWatchSource(auctions), TokenVerifier.fromFile(keyPath), logger, {
    corsOrigins: config.corsOrigins,
    deadlineMs: config.GRPC_DEADLINE_MS,
  });
}
