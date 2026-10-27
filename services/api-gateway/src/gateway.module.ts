import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Client } from '@grpc/grpc-js';
import type { StructuredLogger } from '@artauction/platform';
import { AuthController } from './api/http/auth/auth.controller';
import { AdminController } from './api/http/catalog/admin.controller';
import { CatalogController } from './api/http/catalog/catalog.controller';
import { HealthController } from './api/http/health.controller';
import { GATEWAY_CONFIG, GATEWAY_LOGGER } from './api/http/tokens';
import {
  AUCTION_CLIENT,
  AUDIT_CLIENT,
  CATALOG_CLIENT,
  createAuctionClient,
  createAuditClient,
  createCatalogClient,
  createIdentityClient,
  IDENTITY_CLIENT,
} from './clients/grpc-clients';
import type { GatewayConfig } from './config';

@Module({})
export class GatewayModule implements OnApplicationShutdown {
  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: Client,
    @Inject(CATALOG_CLIENT) private readonly catalog: Client,
    @Inject(AUCTION_CLIENT) private readonly auction: Client,
    @Inject(AUDIT_CLIENT) private readonly audit: Client,
  ) {}

  static register(config: GatewayConfig, logger: StructuredLogger): DynamicModule {
    return {
      module: GatewayModule,
      imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }] })],
      controllers: [AuthController, CatalogController, AdminController, HealthController],
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        { provide: GATEWAY_LOGGER, useValue: logger },
        { provide: IDENTITY_CLIENT, useFactory: () => createIdentityClient(config) },
        { provide: CATALOG_CLIENT, useFactory: () => createCatalogClient(config) },
        { provide: AUCTION_CLIENT, useFactory: () => createAuctionClient(config) },
        { provide: AUDIT_CLIENT, useFactory: () => createAuditClient(config) },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    };
  }

  onApplicationShutdown(): void {
    for (const client of [this.identity, this.catalog, this.auction, this.audit]) {
      client.close();
    }
  }
}
