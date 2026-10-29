import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { notificationHandlersV1, notificationV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { LOGGER, NOTIFICATION_EVENTS_GRPC, NOTIFICATION_GRPC, NotificationModule } from './notification.module';
import { NotificationConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig(NotificationConfig);
  const app = await NestFactory.createApplicationContext(NotificationModule.register(config), { logger: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.notification.v1.NotificationService',
        definition: notificationV1.NotificationServiceService,
        implementation: app.get<notificationV1.NotificationServiceServer>(NOTIFICATION_GRPC),
      },
      {
        name: 'artauction.notification.v1.NotificationEventHandlerService',
        definition: notificationHandlersV1.NotificationEventHandlerServiceService,
        implementation: app.get<notificationHandlersV1.NotificationEventHandlerServiceServer>(NOTIFICATION_EVENTS_GRPC),
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
