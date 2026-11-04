import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Inject, Module, type DynamicModule, type OnApplicationBootstrap, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { aiV1, identityV1, type catalogHandlersV1, type catalogV1 } from '@artauction/contracts';
import {
  channelCredentials,
  DEFAULT_RELAY_OPTIONS,
  OutboxRelay,
  PostgresOutboxStore,
  StructuredLogger,
  TokenVerifier,
} from '@artauction/platform';
import { CallerResolver, ServiceTokenProvider } from '@artauction/service-kit';
import { PrismaClient } from './generated/prisma';
import { GrpcLotTranslator } from './api/clients/translator-client';
import { catalogOutboxRoutes } from './api/events/outbox-routes';
import { catalogEventsGrpcService } from './api/grpc/catalog-events.grpc';
import { catalogGrpcService } from './api/grpc/catalog.grpc';
import {
  CreateLot,
  HashLotImage,
  RegisterLotImage,
  RegisterLotModel,
  RemoveLotModel,
  ResolveManualReview,
  SetLotVisibility,
  SignImageUpload,
  SignModelUpload,
  SubmitLot,
  UpdateLot,
} from './internal/application/commands';
import { ApplyAuditVerdict, MarkLotInAuction, MarkLotSold, RepublishUnsoldLot } from './internal/application/event-handlers';
import {
  BatchGetLotSnapshots,
  FindSimilarImages,
  ListAuctionCandidates,
  ListMyLots,
  ListReviewQueue,
  BatchGetPublicLots,
  GetLotForViewer,
  GetRelatedLots,
  ListCategories,
  ListPublicLots,
} from './internal/application/queries';
import { TranslationWorker } from './internal/application/translation-worker';
import { ImageHashPool } from './internal/infrastructure/image-hash.pool';
import { CATALOG_SCHEMA, PrismaLotRepository, sqlExecutor } from './internal/infrastructure/prisma-lot.repository';
import { PrismaTranslationStore } from './internal/infrastructure/prisma-translation.store';
import { S3ObjectReader } from './internal/infrastructure/s3-object-reader';
import { S3UploadSigner } from './internal/infrastructure/s3-upload-signer';
import type { CatalogConfig } from './config';

// Raiz de composicion del catalogo.

export const LOGGER = Symbol('LOGGER');
export const CATALOG_GRPC = Symbol('CATALOG_GRPC');
export const CATALOG_EVENTS_GRPC = Symbol('CATALOG_EVENTS_GRPC');
const CONFIG = Symbol('CONFIG');
const PRISMA = Symbol('PRISMA');
const HASH_POOL = Symbol('HASH_POOL');
const IDENTITY = Symbol('IDENTITY');
const RELAY = Symbol('RELAY');
const CALLERS = Symbol('CALLERS');
const REPOSITORY = Symbol('REPOSITORY');
const TOKENS = Symbol('TOKENS');
const AI = Symbol('AI');
const TRANSLATION = Symbol('TRANSLATION');

/** Fichas que el reconciliador encola por pasada. */
const TRANSLATION_ENQUEUE_BATCH = 50;
/** Lease de una solicitud: la primera traduccion carga el modelo en ai-service. */
const TRANSLATION_LEASE_MS = 5 * 60_000;

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('catalog-service') },
  {
    provide: PRISMA,
    inject: [CONFIG],
    useFactory: (config: CatalogConfig) => new PrismaClient({ datasourceUrl: config.DATABASE_URL }),
  },
  { provide: REPOSITORY, inject: [PRISMA], useFactory: (prisma: PrismaClient) => new PrismaLotRepository(prisma) },
  {
    provide: HASH_POOL,
    inject: [CONFIG],
    useFactory: (config: CatalogConfig) =>
      new ImageHashPool(
        join(__dirname, 'internal', 'infrastructure', 'image-hash.worker.js'),
        config.IMAGE_HASH_WORKERS > 0 ? config.IMAGE_HASH_WORKERS : undefined,
      ),
  },
  {
    provide: CALLERS,
    inject: [CONFIG],
    useFactory: (config: CatalogConfig) => new CallerResolver(TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH)),
  },
  {
    provide: IDENTITY,
    inject: [CONFIG],
    useFactory: (config: CatalogConfig) =>
      new identityV1.IdentityServiceClient(config.IDENTITY_GRPC_URL, channelCredentials(config.tls)),
  },
  {
    provide: TOKENS,
    inject: [CONFIG, IDENTITY],
    useFactory: (config: CatalogConfig, identity: identityV1.IdentityServiceClient) =>
      new ServiceTokenProvider(identity, config.SERVICE_CLIENT_ID, config.SERVICE_CLIENT_SECRET),
  },
  {
    provide: AI,
    inject: [CONFIG],
    useFactory: (config: CatalogConfig) => new aiV1.AiServiceClient(config.AI_GRPC_URL, channelCredentials(config.tls)),
  },
  {
    provide: TRANSLATION,
    inject: [PRISMA, AI, TOKENS, CONFIG, LOGGER],
    useFactory: (prisma: PrismaClient, ai: aiV1.AiServiceClient, tokens: ServiceTokenProvider, config: CatalogConfig, logger: StructuredLogger) =>
      new TranslationWorker(
        new PrismaTranslationStore(prisma),
        new GrpcLotTranslator(ai, tokens),
        { enqueueBatch: TRANSLATION_ENQUEUE_BATCH, translateBatch: config.TRANSLATION_BATCH, leaseMs: TRANSLATION_LEASE_MS },
        logger,
      ),
  },
  {
    provide: CATALOG_GRPC,
    inject: [CONFIG, REPOSITORY, HASH_POOL, CALLERS, LOGGER],
    useFactory: (
      config: CatalogConfig,
      lots: PrismaLotRepository,
      hashes: ImageHashPool,
      callers: CallerResolver,
      logger: StructuredLogger,
    ): catalogV1.CatalogServiceServer => {
      const signer = new S3UploadSigner({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        expiresInSeconds: config.S3_UPLOAD_TTL_SECONDS,
      });
      const tokens = { next: () => randomBytes(6).toString('hex') };
      // Lee los modelos subidos para validarlos, con la misma llave del catalogo
      // pero por la direccion interna: la firmada es la del navegador.
      const reader = new S3ObjectReader({
        endpoint: config.s3ReadEndpoint,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      });
      return catalogGrpcService(
        {
          listPublic: new ListPublicLots(lots),
          listCategories: new ListCategories(lots),
          related: new GetRelatedLots(lots),
          getForViewer: new GetLotForViewer(lots),
          batchPublic: new BatchGetPublicLots(lots),
          batchSnapshots: new BatchGetLotSnapshots(lots),
          similarImages: new FindSimilarImages(lots),
          auctionCandidates: new ListAuctionCandidates(lots),
          reviewQueue: new ListReviewQueue(lots),
          create: new CreateLot(lots),
          signUpload: new SignImageUpload(lots, signer, tokens),
          registerImage: new RegisterLotImage(lots),
          signModelUpload: new SignModelUpload(lots, signer, tokens),
          registerModel: new RegisterLotModel(lots, reader),
          removeModel: new RemoveLotModel(lots),
          hashImage: new HashLotImage(lots, hashes),
          submit: new SubmitLot(lots),
          update: new UpdateLot(lots),
          myLots: new ListMyLots(lots),
          setVisibility: new SetLotVisibility(lots),
          resolve: new ResolveManualReview(lots),
        },
        callers,
        config.MEDIA_PUBLIC_BASE_URL,
        logger,
      );
    },
  },
  {
    provide: CATALOG_EVENTS_GRPC,
    inject: [REPOSITORY, CALLERS, LOGGER],
    useFactory: (
      lots: PrismaLotRepository,
      callers: CallerResolver,
      logger: StructuredLogger,
    ): catalogHandlersV1.CatalogEventHandlerServiceServer =>
      catalogEventsGrpcService(
        {
          applyAuditVerdict: new ApplyAuditVerdict(lots),
          markInAuction: new MarkLotInAuction(lots),
          markSold: new MarkLotSold(lots),
          republish: new RepublishUnsoldLot(lots),
        },
        callers,
        logger,
      ),
  },
  {
    provide: RELAY,
    inject: [CONFIG, PRISMA, TOKENS, LOGGER],
    useFactory: (
      config: CatalogConfig,
      prisma: PrismaClient,
      tokens: ServiceTokenProvider,
      logger: StructuredLogger,
    ) => {
      const delivery = catalogOutboxRoutes(
        {
          gallery: config.GALLERY_EVENTS_GRPC_URL,
          audit: config.AUDIT_EVENTS_GRPC_URL,
          auction: config.AUCTION_EVENTS_GRPC_URL,
          notification: config.NOTIFICATION_EVENTS_GRPC_URL,
        },
        channelCredentials(config.tls),
        tokens,
      );
      const relay = new OutboxRelay(new PostgresOutboxStore(sqlExecutor(prisma), CATALOG_SCHEMA), delivery.routes, logger, DEFAULT_RELAY_OPTIONS);
      return { relay, close: delivery.close };
    },
  },
];

@Module({})
export class CatalogModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private translationTimer: NodeJS.Timeout | null = null;
  private translating = false;

  constructor(
    @Inject(CONFIG) private readonly config: CatalogConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(HASH_POOL) private readonly hashes: ImageHashPool,
    @Inject(IDENTITY) private readonly identity: identityV1.IdentityServiceClient,
    @Inject(RELAY) private readonly relay: { relay: OutboxRelay; close: () => void },
    @Inject(AI) private readonly ai: aiV1.AiServiceClient,
    @Inject(TRANSLATION) private readonly translation: TranslationWorker,
    @Inject(LOGGER) private readonly logger: StructuredLogger,
  ) {}

  static register(config: CatalogConfig): DynamicModule {
    return {
      module: CatalogModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [LOGGER, CATALOG_GRPC, CATALOG_EVENTS_GRPC],
    };
  }

  onApplicationBootstrap(): void {
    if (this.config.OUTBOX_RELAY_ENABLED) {
      this.relay.relay.start();
    }
    if (this.config.TRANSLATION_ENABLED) {
      this.translationTimer = setInterval(() => {
        void this.translate();
      }, this.config.TRANSLATION_INTERVAL_MS);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.translationTimer) {
      clearInterval(this.translationTimer);
    }
    this.relay.relay.stop();
    this.relay.close();
    this.identity.close();
    this.ai.close();
    await Promise.allSettled([this.hashes.close(), this.prisma.$disconnect()]);
  }

  /** Una pasada de traduccion a la vez; un fallo se registra y la siguiente reintenta. */
  private async translate(): Promise<void> {
    if (this.translating) {
      return;
    }
    this.translating = true;
    try {
      const { enqueued, processed } = await this.translation.tick();
      if (enqueued > 0 || processed > 0) {
        this.logger.log(`traducciones: ${String(enqueued)} encoladas, ${String(processed)} procesadas`, 'translation');
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error), undefined, 'translation');
    } finally {
      this.translating = false;
    }
  }
}
