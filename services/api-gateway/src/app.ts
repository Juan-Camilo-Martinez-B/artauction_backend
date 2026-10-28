import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import type { StructuredLogger } from '@artauction/platform';
import { GrpcExceptionFilter } from './api/http/grpc-exception.filter';
import { BODY_LIMITS, createLegacyProxy, MIGRATED_PREFIXES } from './api/http/legacy-proxy';
import { LIVE_ROOM } from './api/http/tokens';
import type { LiveRoom } from './api/live/live-room';
import type { GatewayConfig } from './config';
import { GatewayModule } from './gateway.module';

/**
 * Ensambla el gateway: CORS, proxy al monolito para lo no migrado, sala en
 * vivo, parseo de cuerpo solo en rutas propias, validacion y traduccion de
 * errores gRPC.
 */
export async function createGateway(config: GatewayConfig, logger: StructuredLogger): Promise<NestExpressApplication> {
  // Sin body parser global: el cuerpo de las rutas reenviadas al monolito debe
  // llegar intacto. Solo las rutas migradas se parsean aqui.
  const app = await NestFactory.create<NestExpressApplication>(GatewayModule.register(config, logger), {
    logger,
    bodyParser: false,
  });
  app.disable('x-powered-by');
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  const proxy = config.LEGACY_URL ? createLegacyProxy(config.LEGACY_URL, logger) : null;
  if (proxy) {
    app.use(proxy);
  }
  // Socket.IO se monta sobre el servidor HTTP y atiende /socket.io antes que
  // Express, asi que el proxy al monolito nunca ve esas peticiones.
  app.get<LiveRoom | null>(LIVE_ROOM)?.attach(app.getHttpServer());
  for (const prefix of MIGRATED_PREFIXES) {
    app.use(prefix, json({ limit: BODY_LIMITS[prefix] ?? '1mb' }));
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GrpcExceptionFilter(logger));
  return app;
}
