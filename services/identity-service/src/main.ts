import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { identityV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { IdentityConfig } from './config';
import { GRPC_SERVICE, IdentityModule, LOGGER } from './identity.module';

async function bootstrap(): Promise<void> {
  const config = loadConfig(IdentityConfig);
  const app = await NestFactory.createApplicationContext(IdentityModule.register(config), { logger: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.identity.v1.IdentityService',
        definition: identityV1.IdentityServiceService,
        implementation: app.get<identityV1.IdentityServiceServer>(GRPC_SERVICE),
      },
    ],
  });
  const stop = async (): Promise<void> => {
    await server.shutdown();
    await app.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
