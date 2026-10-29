import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { aiV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { AI_GRPC, AiModule, LOGGER } from './ai.module';
import { AiConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig(AiConfig);
  // Sin logger de Nest, abortOnError haria que un fallo de arranque (por ejemplo
  // una clave ilegible) terminara el proceso sin mensaje; asi llega al catch.
  const app = await NestFactory.createApplicationContext(AiModule.register(config), { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.ai.v1.AiService',
        definition: aiV1.AiServiceService,
        implementation: app.get<aiV1.AiServiceServer>(AI_GRPC),
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
