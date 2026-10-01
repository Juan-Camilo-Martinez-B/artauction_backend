import { Module } from '@nestjs/common';
import { EnvModule } from './common/config/env.module';
import { HealthModule } from './health/health.module';
import { PostgresModule } from './infra/postgres/postgres.module';

@Module({
  imports: [EnvModule, PostgresModule, HealthModule],
})
export class AppModule {}
