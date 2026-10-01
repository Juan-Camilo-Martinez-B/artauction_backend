import { Module } from '@nestjs/common';
import { EnvModule } from './common/config/env.module';
import { HealthModule } from './health/health.module';
import { MongoModule } from './infra/mongo/mongo.module';
import { PostgresModule } from './infra/postgres/postgres.module';

@Module({
  imports: [EnvModule, PostgresModule, MongoModule.forRoot(), HealthModule],
})
export class AppModule {}
