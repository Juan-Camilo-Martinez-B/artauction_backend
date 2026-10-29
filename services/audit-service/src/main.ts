import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { auditHandlersV1, auditV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { AuditConfig } from './config';
import { AUDIT_EVENTS_GRPC, AUDIT_GRPC, AuditModule, LOGGER } from './audit.module';

async function bootstrap(): Promise<void> {
  const config = loadConfig(AuditConfig);
  const app = await NestFactory.createApplicationContext(AuditModule.register(config), { logger: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.audit.v1.AuditService',
        definition: auditV1.AuditServiceService,
        implementation: app.get<auditV1.AuditServiceServer>(AUDIT_GRPC),
      },
      {
        name: 'artauction.audit.v1.AuditEventHandlerService',
        definition: auditHandlersV1.AuditEventHandlerServiceService,
        implementation: app.get<auditHandlersV1.AuditEventHandlerServiceServer>(AUDIT_EVENTS_GRPC),
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
