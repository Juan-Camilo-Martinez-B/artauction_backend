import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { identityV1 } from '@artauction/contracts';
import { AuthController } from './api/http/auth/auth.controller';
import { HealthController } from './api/http/health.controller';
import { GATEWAY_CONFIG } from './api/http/tokens';
import { createIdentityClient, IDENTITY_CLIENT } from './clients/grpc-clients';
import type { GatewayConfig } from './config';

@Module({})
export class GatewayModule implements OnApplicationShutdown {
  constructor(@Inject(IDENTITY_CLIENT) private readonly identity: identityV1.IdentityServiceClient) {}

  static register(config: GatewayConfig): DynamicModule {
    return {
      module: GatewayModule,
      imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }] })],
      controllers: [AuthController, HealthController],
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        { provide: IDENTITY_CLIENT, useFactory: () => createIdentityClient(config) },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    };
  }

  onApplicationShutdown(): void {
    this.identity.close();
  }
}
