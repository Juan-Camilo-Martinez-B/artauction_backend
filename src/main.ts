import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppLogger } from './common/logger/app-logger';
import { ENV, type Environment } from './common/config/environment';

async function bootstrap(): Promise<void> {
  const logger = new AppLogger();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  const env = app.get<Environment>(ENV);
  // Transitorio: detras del api-gateway, la IP real llega en X-Forwarded-For.
  // Solo se confia en un proxy local para que el rate limit no comparta cupo.
  app.set('trust proxy', 'loopback');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({ origin: env.corsOriginList, credentials: true });
  const config = new DocumentBuilder()
    .setTitle('ArtAuction AI')
    .setDescription('API de subastas. El reloj de la sala es el del servidor.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
