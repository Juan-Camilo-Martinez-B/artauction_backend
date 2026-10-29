import { Inject, Module, type DynamicModule, type OnApplicationBootstrap, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { aiV1, catalogV1, identityV1, type auditHandlersV1, type auditV1 } from '@artauction/contracts';
import {
  channelCredentials,
  DEFAULT_RELAY_OPTIONS,
  OutboxRelay,
  PostgresOutboxStore,
  sqlExecutorFrom,
  StructuredLogger,
  TokenVerifier,
} from '@artauction/platform';
import { CallerResolver, ServiceTokenProvider } from '@artauction/service-kit';
import { MongoClient } from 'mongodb';
import { PrismaClient } from './generated/prisma';
import { GrpcAiClient } from './api/clients/ai-client';
import { GrpcCatalogClient } from './api/clients/catalog-client';
import { auditOutboxRoutes } from './api/events/outbox-routes';
import { auditEventsGrpcService, auditGrpcService } from './api/grpc/audit.grpc';
import { EnqueueAudit, GetLatestSummaries, RunAuditWorker } from './internal/application/use-cases';
import { MediaFetcher } from './internal/infrastructure/media-fetcher';
import { MongoReportStore } from './internal/infrastructure/mongo-report.store';
import { PrismaAuditRepository } from './internal/infrastructure/prisma-audit.repository';
import { SharpImageAnalyzer } from './internal/infrastructure/sharp-image-analyzer';
import type { AuditConfig } from './config';

// Raiz de composicion de audit-service.

export const LOGGER = Symbol('LOGGER');
export const AUDIT_GRPC = Symbol('AUDIT_GRPC');
export const AUDIT_EVENTS_GRPC = Symbol('AUDIT_EVENTS_GRPC');
const CONFIG = Symbol('CONFIG');
const PRISMA = Symbol('PRISMA');
const MONGO = Symbol('MONGO');
const REPOSITORY = Symbol('REPOSITORY');
const CLIENTS = Symbol('CLIENTS');
const WORKER = Symbol('WORKER');
const RELAY = Symbol('RELAY');

const clock = { now: () => new Date() };

interface Clients {
  identity: identityV1.IdentityServiceClient;
  catalog: catalogV1.CatalogServiceClient;
  ai: aiV1.AiServiceClient;
  tokens: ServiceTokenProvider;
}

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('audit-service') },
  {
    provide: PRISMA,
    inject: [CONFIG],
    useFactory: (config: AuditConfig) => new PrismaClient({ datasourceUrl: config.DATABASE_URL }),
  },
  {
    provide: MONGO,
    inject: [CONFIG],
    useFactory: async (config: AuditConfig) => new MongoClient(config.MONGODB_URI).connect(),
  },
  { provide: REPOSITORY, inject: [PRISMA], useFactory: (prisma: PrismaClient) => new PrismaAuditRepository(prisma) },
  {
    provide: CLIENTS,
    inject: [CONFIG],
    useFactory: (config: AuditConfig): Clients => {
      const channel = channelCredentials(config.tls);
      const identity = new identityV1.IdentityServiceClient(config.IDENTITY_GRPC_URL, channel);
      return {
        identity,
        catalog: new catalogV1.CatalogServiceClient(config.CATALOG_GRPC_URL, channel),
        ai: new aiV1.AiServiceClient(config.AI_GRPC_URL, channel),
        tokens: new ServiceTokenProvider(identity, config.SERVICE_CLIENT_ID, config.SERVICE_CLIENT_SECRET),
      };
    },
  },
  {
    provide: AUDIT_GRPC,
    inject: [REPOSITORY, LOGGER],
    useFactory: (audits: PrismaAuditRepository, logger: StructuredLogger): auditV1.AuditServiceServer =>
      auditGrpcService(new GetLatestSummaries(audits), logger),
  },
  {
    provide: AUDIT_EVENTS_GRPC,
    inject: [CONFIG, REPOSITORY, LOGGER],
    useFactory: (config: AuditConfig, audits: PrismaAuditRepository, logger: StructuredLogger): auditHandlersV1.AuditEventHandlerServiceServer =>
      auditEventsGrpcService(new EnqueueAudit(audits), new CallerResolver(TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH)), logger),
  },
  {
    provide: WORKER,
    inject: [CONFIG, REPOSITORY, MONGO, CLIENTS, LOGGER],
    useFactory: (config: AuditConfig, audits: PrismaAuditRepository, mongo: MongoClient, clients: Clients, logger: StructuredLogger) =>
      new RunAuditWorker({
        audits,
        reports: new MongoReportStore(mongo, config.MONGODB_DATABASE),
        catalog: new GrpcCatalogClient(clients.catalog, clients.tokens),
        images: new SharpImageAnalyzer(
          new MediaFetcher({
            allowedHosts: config.imageHosts,
            publicMediaBase: config.MEDIA_PUBLIC_BASE_URL,
            internalMediaBase: config.MEDIA_INTERNAL_BASE_URL,
            timeoutMs: config.IMAGE_FETCH_TIMEOUT_MS,
            maxBytes: config.IMAGE_MAX_BYTES,
          }),
        ),
        ai: new GrpcAiClient(clients.ai, clients.tokens),
        clock,
        logger,
      }),
  },
  {
    provide: RELAY,
    inject: [CONFIG, PRISMA, CLIENTS, LOGGER],
    useFactory: (config: AuditConfig, prisma: PrismaClient, clients: Clients, logger: StructuredLogger) => {
      const delivery = auditOutboxRoutes(
        { catalog: config.CATALOG_GRPC_URL, auction: config.AUCTION_EVENTS_GRPC_URL, notification: config.NOTIFICATION_EVENTS_GRPC_URL },
        channelCredentials(config.tls),
        clients.tokens,
      );
      const relay = new OutboxRelay(new PostgresOutboxStore(sqlExecutorFrom(prisma), 'audit'), delivery.routes, logger, DEFAULT_RELAY_OPTIONS);
      return { relay, close: delivery.close };
    },
  },
];

@Module({})
export class AuditModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CONFIG) private readonly config: AuditConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MONGO) private readonly mongo: MongoClient,
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(WORKER) private readonly worker: RunAuditWorker,
    @Inject(RELAY) private readonly relay: { relay: OutboxRelay; close: () => void },
    @Inject(LOGGER) private readonly logger: StructuredLogger,
  ) {}

  static register(config: AuditConfig): DynamicModule {
    return {
      module: AuditModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [LOGGER, AUDIT_GRPC, AUDIT_EVENTS_GRPC],
    };
  }

  onApplicationBootstrap(): void {
    if (this.config.OUTBOX_RELAY_ENABLED) {
      this.relay.relay.start();
    }
    if (this.config.WORKER_ENABLED) {
      this.timer = setInterval(() => {
        void this.tick();
      }, this.config.WORKER_INTERVAL_MS);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.relay.relay.stop();
    this.relay.close();
    for (const client of [this.clients.identity, this.clients.catalog, this.clients.ai]) {
      client.close();
    }
    await this.mongo.close();
    await this.prisma.$disconnect();
  }

  /** Una pasada del worker a la vez; un fallo se registra y la siguiente reintenta. */
  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const processed = await this.worker.tick();
      if (processed > 0) {
        this.logger.log(`auditorias procesadas: ${String(processed)}`, 'audit-worker');
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error), undefined, 'audit-worker');
    } finally {
      this.running = false;
    }
  }
}
