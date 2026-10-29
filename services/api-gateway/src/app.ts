import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import type { StructuredLogger } from '@artauction/platform';
import { GrpcExceptionFilter } from './api/http/grpc-exception.filter';
import { LIVE_ROOM } from './api/http/tokens';
import type { LiveRoom } from './api/live/live-room';
import type { GatewayConfig } from './config';
import { GatewayModule } from './gateway.module';

/** /lots recibe imagenes en base64 para el hash perceptual; el resto, JSON pequenos. */
const LARGE_BODY_PREFIX = '/lots';
const LARGE_BODY_LIMIT = '12mb';
const DEFAULT_BODY_LIMIT = '1mb';

/**
 * Ensambla el gateway: CORS, limites de cuerpo, sala en vivo, documentacion
 * OpenAPI, validacion y traduccion de errores gRPC. Desde F9 no queda ningun
 * proxy: todas las rutas las atienden los microservicios.
 */
export async function createGateway(config: GatewayConfig, logger: StructuredLogger): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(GatewayModule.register(config, logger), {
    logger,
    bodyParser: false,
  });
  app.disable('x-powered-by');
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  // El primer parser que lee el cuerpo gana; el general ya no lo vuelve a leer.
  app.use(LARGE_BODY_PREFIX, json({ limit: LARGE_BODY_LIMIT }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  // Socket.IO se monta sobre el servidor HTTP y atiende /socket.io antes que Express.
  app.get<LiveRoom | null>(LIVE_ROOM)?.attach(app.getHttpServer());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new GrpcExceptionFilter(logger));
  const openApi = new DocumentBuilder()
    .setTitle('ArtAuction AI')
    .setDescription('API REST del frontend. Cada ruta la atiende un microservicio por gRPC detras del gateway.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, openApi));
  return app;
}
