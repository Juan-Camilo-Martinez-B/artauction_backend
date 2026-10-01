import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { EnvModule } from './common/config/env.module';
import { HealthModule } from './health/health.module';
import { MongoModule } from './infra/mongo/mongo.module';
import { PostgresModule } from './infra/postgres/postgres.module';
import { IdentidadModule } from './modules/identidad/identidad.module';

@Module({
  imports: [
    EnvModule,
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
    }),
    PostgresModule,
    MongoModule.forRoot(),
    HealthModule,
    IdentidadModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
