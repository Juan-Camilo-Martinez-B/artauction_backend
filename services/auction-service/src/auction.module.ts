import { Inject, Module, type DynamicModule, type OnApplicationBootstrap, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { catalogV1, identityV1, walletV1, type auctionHandlersV1, type auctionV1 } from '@artauction/contracts';
import {
  channelCredentials,
  DEFAULT_RELAY_OPTIONS,
  KeyedSerialQueue,
  OutboxRelay,
  PostgresOutboxStore,
  sqlExecutorFrom,
  StructuredLogger,
  TokenVerifier,
} from '@artauction/platform';
import { CallerResolver, ServiceTokenProvider } from '@artauction/service-kit';
import { PrismaClient } from './generated/prisma';
import { GrpcCatalogClient } from './api/clients/catalog-client';
import { GrpcWalletClient } from './api/clients/wallet-client';
import { auctionOutboxRoutes } from './api/events/outbox-routes';
import { auctionEventsGrpcService } from './api/grpc/auction-events.grpc';
import { auctionGrpcService } from './api/grpc/auction.grpc';
import { LiveBus } from './api/live/live-bus';
import { PlaceBid, WithdrawBid } from './internal/application/bidding';
import { BatchGetAuctionSummaries, GetAuction, GetBidByReservation } from './internal/application/queries';
import { OpenAuction, RunScheduler, ScheduleApprovedLot } from './internal/application/scheduling';
import { AUCTION_SCHEMA, PrismaAuctionRepository } from './internal/infrastructure/prisma-auction.repository';
import type { AuctionConfig } from './config';

// Raiz de composicion de auction-service.

export const LOGGER = Symbol('LOGGER');
export const AUCTION_GRPC = Symbol('AUCTION_GRPC');
export const AUCTION_EVENTS_GRPC = Symbol('AUCTION_EVENTS_GRPC');
const CONFIG = Symbol('CONFIG');
const PRISMA = Symbol('PRISMA');
const REPOSITORY = Symbol('REPOSITORY');
const CALLERS = Symbol('CALLERS');
const CLIENTS = Symbol('CLIENTS');
const LIVE = Symbol('LIVE');
const SCHEDULER = Symbol('SCHEDULER');
const RELAY = Symbol('RELAY');

const clock = { now: () => new Date() };

interface Clients {
  identity: identityV1.IdentityServiceClient;
  wallet: walletV1.WalletServiceClient;
  catalog: catalogV1.CatalogServiceClient;
  tokens: ServiceTokenProvider;
}

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('auction-service') },
  { provide: LIVE, useValue: new LiveBus() },
  {
    provide: PRISMA,
    inject: [CONFIG],
    useFactory: (config: AuctionConfig) => new PrismaClient({ datasourceUrl: config.DATABASE_URL }),
  },
  { provide: REPOSITORY, inject: [PRISMA], useFactory: (prisma: PrismaClient) => new PrismaAuctionRepository(prisma) },
  {
    provide: CALLERS,
    inject: [CONFIG],
    useFactory: (config: AuctionConfig) => new CallerResolver(TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH)),
  },
  {
    provide: CLIENTS,
    inject: [CONFIG],
    useFactory: (config: AuctionConfig): Clients => {
      const channel = channelCredentials(config.tls);
      const identity = new identityV1.IdentityServiceClient(config.IDENTITY_GRPC_URL, channel);
      return {
        identity,
        wallet: new walletV1.WalletServiceClient(config.WALLET_GRPC_URL, channel),
        catalog: new catalogV1.CatalogServiceClient(config.CATALOG_GRPC_URL, channel),
        tokens: new ServiceTokenProvider(identity, config.SERVICE_CLIENT_ID, config.SERVICE_CLIENT_SECRET),
      };
    },
  },
  {
    provide: AUCTION_GRPC,
    inject: [REPOSITORY, CLIENTS, CALLERS, LIVE, LOGGER],
    useFactory: (
      auctions: PrismaAuctionRepository,
      clients: Clients,
      callers: CallerResolver,
      live: LiveBus,
      logger: StructuredLogger,
    ): auctionV1.AuctionServiceServer => {
      // Una sola cola por sala para pujas y retiros: nunca corren a la vez en la misma subasta.
      const lane = new KeyedSerialQueue();
      return auctionGrpcService(
        {
          getAuction: new GetAuction(auctions),
          openAuction: new OpenAuction(auctions, new GrpcCatalogClient(clients.catalog, clients.tokens), clock),
          placeBid: new PlaceBid(auctions, new GrpcWalletClient(clients.wallet, clients.tokens), live, clock, lane),
          withdrawBid: new WithdrawBid(auctions, clock, lane),
          summaries: new BatchGetAuctionSummaries(auctions),
          bidByReservation: new GetBidByReservation(auctions),
        },
        callers,
        live,
        logger,
      );
    },
  },
  {
    provide: AUCTION_EVENTS_GRPC,
    inject: [REPOSITORY, CALLERS, LOGGER],
    useFactory: (
      auctions: PrismaAuctionRepository,
      callers: CallerResolver,
      logger: StructuredLogger,
    ): auctionHandlersV1.AuctionEventHandlerServiceServer =>
      auctionEventsGrpcService(new ScheduleApprovedLot(auctions, clock), callers, logger),
  },
  {
    provide: SCHEDULER,
    inject: [REPOSITORY, LIVE],
    useFactory: (auctions: PrismaAuctionRepository, live: LiveBus) => new RunScheduler(auctions, live, clock),
  },
  {
    provide: RELAY,
    inject: [CONFIG, PRISMA, CLIENTS, LOGGER],
    useFactory: (config: AuctionConfig, prisma: PrismaClient, clients: Clients, logger: StructuredLogger) => {
      const delivery = auctionOutboxRoutes(
        {
          wallet: config.WALLET_GRPC_URL,
          catalog: config.CATALOG_GRPC_URL,
          gallery: config.GALLERY_EVENTS_GRPC_URL,
          notification: config.NOTIFICATION_EVENTS_GRPC_URL,
        },
        channelCredentials(config.tls),
        clients.tokens,
      );
      const relay = new OutboxRelay(new PostgresOutboxStore(sqlExecutorFrom(prisma), AUCTION_SCHEMA), delivery.routes, logger, DEFAULT_RELAY_OPTIONS);
      return { relay, close: delivery.close };
    },
  },
];

@Module({})
export class AuctionModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CONFIG) private readonly config: AuctionConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(SCHEDULER) private readonly scheduler: RunScheduler,
    @Inject(RELAY) private readonly relay: { relay: OutboxRelay; close: () => void },
    @Inject(LOGGER) private readonly logger: StructuredLogger,
  ) {}

  static register(config: AuctionConfig): DynamicModule {
    return {
      module: AuctionModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [LOGGER, AUCTION_GRPC, AUCTION_EVENTS_GRPC],
    };
  }

  onApplicationBootstrap(): void {
    if (this.config.OUTBOX_RELAY_ENABLED) {
      this.relay.relay.start();
    }
    if (this.config.SCHEDULER_ENABLED) {
      this.timer = setInterval(() => {
        void this.tick();
      }, this.config.SCHEDULER_INTERVAL_MS);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.relay.relay.stop();
    this.relay.close();
    for (const client of [this.clients.identity, this.clients.wallet, this.clients.catalog]) {
      client.close();
    }
    await this.prisma.$disconnect();
  }

  /** Una pasada del planificador a la vez; un fallo se registra y la siguiente reintenta. */
  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.scheduler.execute();
      if (result.opened + result.closed + result.rescheduled > 0) {
        this.logger.log(
          `abiertas ${String(result.opened)}, cerradas ${String(result.closed)}, reprogramadas ${String(result.rescheduled)}`,
          'scheduler',
        );
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error), undefined, 'scheduler');
    } finally {
      this.running = false;
    }
  }
}
