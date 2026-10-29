import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { walletHandlersV1, walletV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { WalletConfig } from './config';
import { LOGGER, WALLET_EVENTS_GRPC, WALLET_GRPC, WalletModule } from './wallet.module';

async function bootstrap(): Promise<void> {
  const config = loadConfig(WalletConfig);
  const app = await NestFactory.createApplicationContext(WalletModule.register(config), { logger: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.wallet.v1.WalletService',
        definition: walletV1.WalletServiceService,
        implementation: app.get<walletV1.WalletServiceServer>(WALLET_GRPC),
      },
      {
        name: 'artauction.wallet.v1.WalletEventHandlerService',
        definition: walletHandlersV1.WalletEventHandlerServiceService,
        implementation: app.get<walletHandlersV1.WalletEventHandlerServiceServer>(WALLET_EVENTS_GRPC),
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
