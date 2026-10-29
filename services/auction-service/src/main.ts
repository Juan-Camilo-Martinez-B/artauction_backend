import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { auctionHandlersV1, auctionV1 } from '@artauction/contracts';
import { loadConfig, type StructuredLogger } from '@artauction/platform';
import { startGrpcServer } from '@artauction/service-kit';
import { AUCTION_EVENTS_GRPC, AUCTION_GRPC, AuctionModule, LOGGER } from './auction.module';
import { AuctionConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig(AuctionConfig);
  const app = await NestFactory.createApplicationContext(AuctionModule.register(config), { logger: false });
  app.enableShutdownHooks();
  const logger = app.get<StructuredLogger>(LOGGER);
  const server = await startGrpcServer({
    host: config.GRPC_HOST,
    port: config.GRPC_PORT,
    tls: config.tls,
    logger,
    services: [
      {
        name: 'artauction.auction.v1.AuctionService',
        definition: auctionV1.AuctionServiceService,
        implementation: app.get<auctionV1.AuctionServiceServer>(AUCTION_GRPC),
      },
      {
        name: 'artauction.auction.v1.AuctionEventHandlerService',
        definition: auctionHandlersV1.AuctionEventHandlerServiceService,
        implementation: app.get<auctionHandlersV1.AuctionEventHandlerServiceServer>(AUCTION_EVENTS_GRPC),
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
