import { Inject, Module, type DynamicModule, type OnApplicationBootstrap, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { auctionV1, identityV1, type walletHandlersV1, type walletV1 } from '@artauction/contracts';
import { channelCredentials, StructuredLogger, TokenVerifier } from '@artauction/platform';
import { CallerResolver, ServiceTokenProvider } from '@artauction/service-kit';
import { PrismaClient } from './generated/prisma';
import { AuctionBidLookup } from './api/clients/auction-bid-lookup';
import { walletEventsGrpcService } from './api/grpc/wallet-events.grpc';
import { walletGrpcService } from './api/grpc/wallet.grpc';
import {
  ConfirmBidHold,
  GetWallet,
  ReleaseAuctionHolds,
  ReleaseBidderHold,
  SettleClosedAuction,
  SweepExpiredReservations,
  TopUp,
  TryHold,
} from './internal/application/use-cases';
import { PrismaWalletRepository } from './internal/infrastructure/prisma-wallet.repository';
import { SimulatedPaymentGateway } from './internal/infrastructure/simulated-payment-gateway';
import type { WalletConfig } from './config';

// Raiz de composicion del bolsillo.

export const LOGGER = Symbol('LOGGER');
export const WALLET_GRPC = Symbol('WALLET_GRPC');
export const WALLET_EVENTS_GRPC = Symbol('WALLET_EVENTS_GRPC');
const CONFIG = Symbol('CONFIG');
const PRISMA = Symbol('PRISMA');
const REPOSITORY = Symbol('REPOSITORY');
const CALLERS = Symbol('CALLERS');
const CLIENTS = Symbol('CLIENTS');
const SWEEPER = Symbol('SWEEPER');

const clock = { now: () => new Date() };

interface Clients {
  identity: identityV1.IdentityServiceClient;
  auction: auctionV1.AuctionServiceClient;
}

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('wallet-service') },
  {
    provide: PRISMA,
    inject: [CONFIG],
    useFactory: (config: WalletConfig) => new PrismaClient({ datasourceUrl: config.DATABASE_URL }),
  },
  { provide: REPOSITORY, inject: [PRISMA], useFactory: (prisma: PrismaClient) => new PrismaWalletRepository(prisma) },
  {
    provide: CALLERS,
    inject: [CONFIG],
    useFactory: (config: WalletConfig) => new CallerResolver(TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH)),
  },
  {
    provide: CLIENTS,
    inject: [CONFIG],
    useFactory: (config: WalletConfig): Clients => ({
      identity: new identityV1.IdentityServiceClient(config.IDENTITY_GRPC_URL, channelCredentials(config.tls)),
      auction: new auctionV1.AuctionServiceClient(config.AUCTION_GRPC_URL, channelCredentials(config.tls)),
    }),
  },
  {
    provide: WALLET_GRPC,
    inject: [REPOSITORY, CALLERS, LOGGER],
    useFactory: (wallets: PrismaWalletRepository, callers: CallerResolver, logger: StructuredLogger): walletV1.WalletServiceServer =>
      walletGrpcService(
        {
          getWallet: new GetWallet(wallets),
          topUp: new TopUp(wallets, new SimulatedPaymentGateway()),
          tryHold: new TryHold(wallets, clock),
        },
        callers,
        logger,
      ),
  },
  {
    provide: WALLET_EVENTS_GRPC,
    inject: [CONFIG, REPOSITORY, CALLERS, LOGGER],
    useFactory: (
      config: WalletConfig,
      wallets: PrismaWalletRepository,
      callers: CallerResolver,
      logger: StructuredLogger,
    ): walletHandlersV1.WalletEventHandlerServiceServer =>
      walletEventsGrpcService(
        {
          confirm: new ConfirmBidHold(wallets),
          releaseBidder: new ReleaseBidderHold(wallets),
          settle: new SettleClosedAuction(wallets, config.PLATFORM_FEE_BPS),
          releaseAuction: new ReleaseAuctionHolds(wallets),
        },
        callers,
        logger,
      ),
  },
  {
    provide: SWEEPER,
    inject: [CONFIG, REPOSITORY, CLIENTS, LOGGER],
    useFactory: (config: WalletConfig, wallets: PrismaWalletRepository, clients: Clients, logger: StructuredLogger) => {
      const tokens = new ServiceTokenProvider(clients.identity, config.SERVICE_CLIENT_ID, config.SERVICE_CLIENT_SECRET);
      return new SweepExpiredReservations(wallets, new AuctionBidLookup(clients.auction, tokens, logger), clock);
    },
  },
];

@Module({})
export class WalletModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(CONFIG) private readonly config: WalletConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(SWEEPER) private readonly sweeper: SweepExpiredReservations,
    @Inject(LOGGER) private readonly logger: StructuredLogger,
  ) {}

  static register(config: WalletConfig): DynamicModule {
    return {
      module: WalletModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [LOGGER, WALLET_GRPC, WALLET_EVENTS_GRPC],
    };
  }

  onApplicationBootstrap(): void {
    if (!this.config.RESERVATION_SWEEP_ENABLED) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.config.RESERVATION_SWEEP_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.clients.identity.close();
    this.clients.auction.close();
    await this.prisma.$disconnect();
  }

  /** Un barrido a la vez; un fallo se registra y el siguiente lo reintenta. */
  private async sweep(): Promise<void> {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    try {
      const resolved = await this.sweeper.execute();
      if (resolved > 0) {
        this.logger.log(`reservas vencidas resueltas: ${String(resolved)}`, 'reservations');
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error), undefined, 'reservations');
    } finally {
      this.sweeping = false;
    }
  }
}
