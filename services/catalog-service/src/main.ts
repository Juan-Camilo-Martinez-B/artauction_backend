import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { catalogHandlersV1, catalogV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { CATALOG_EVENTS_GRPC, CATALOG_GRPC, CatalogModule, LOGGER } from './catalog.module';
import { CatalogConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig(CatalogConfig);
  // Sin logger de Nest, abortOnError haria que un fallo de arranque (por ejemplo
  // una clave ilegible) terminara el proceso sin mensaje; asi llega al catch.
  const app = await NestFactory.createApplicationContext(CatalogModule.register(config), { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.catalog.v1.CatalogService',
        definition: catalogV1.CatalogServiceService,
        implementation: app.get<catalogV1.CatalogServiceServer>(CATALOG_GRPC),
      },
      {
        name: 'artauction.catalog.v1.CatalogEventHandlerService',
        definition: catalogHandlersV1.CatalogEventHandlerServiceService,
        implementation: app.get<catalogHandlersV1.CatalogEventHandlerServiceServer>(CATALOG_EVENTS_GRPC),
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
