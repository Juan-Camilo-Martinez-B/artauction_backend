import 'reflect-metadata';
import { loadConfig, StructuredLogger } from '@artauction/platform';
import { createGateway } from './app';
import { GatewayConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig(GatewayConfig);
  const logger = new StructuredLogger('api-gateway');
  const app = await createGateway(config, logger);
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  logger.log(`HTTP escuchando en :${String(config.PORT)}; legado ${config.LEGACY_URL || 'desactivado'}`, 'http');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
