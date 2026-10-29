import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { galleryHandlersV1, galleryV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { GalleryConfigEnv } from './config';
import { GALLERY_EVENTS_GRPC, GALLERY_GRPC, GalleryModule, LOGGER } from './gallery.module';

async function bootstrap(): Promise<void> {
  const config = loadConfig(GalleryConfigEnv);
  // Sin logger de Nest, abortOnError haria que un fallo de arranque (por ejemplo
  // una clave ilegible) terminara el proceso sin mensaje; asi llega al catch.
  const app = await NestFactory.createApplicationContext(GalleryModule.register(config), { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.gallery.v1.GalleryService',
        definition: galleryV1.GalleryServiceService,
        implementation: app.get<galleryV1.GalleryServiceServer>(GALLERY_GRPC),
      },
      {
        name: 'artauction.gallery.v1.GalleryEventHandlerService',
        definition: galleryHandlersV1.GalleryEventHandlerServiceService,
        implementation: app.get<galleryHandlersV1.GalleryEventHandlerServiceServer>(GALLERY_EVENTS_GRPC),
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
