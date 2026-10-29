import { Inject, Module, type DynamicModule, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { aiV1, catalogV1, identityV1, type galleryHandlersV1, type galleryV1 } from '@artauction/contracts';
import { channelCredentials, StructuredLogger, TokenVerifier } from '@artauction/platform';
import { CallerResolver, ServiceTokenProvider } from '@artauction/service-kit';
import { MongoClient } from 'mongodb';
import { PrismaClient } from './generated/prisma';
import { AiGalleryDesigner, GrpcCatalogClient, GrpcIdentityClient } from './api/clients/clients';
import { galleryEventsGrpcService, galleryGrpcService } from './api/grpc/gallery.grpc';
import { GalleryEventHandlers, PersonalGalleryUseCases, SocialUseCases } from './internal/application/use-cases';
import { MongoSocialStore } from './internal/infrastructure/mongo-social.store';
import { PrismaGalleryRepository } from './internal/infrastructure/prisma-gallery.repository';
import type { GalleryConfigEnv } from './config';

// Raiz de composicion de gallery-service.

export const LOGGER = Symbol('LOGGER');
export const GALLERY_GRPC = Symbol('GALLERY_GRPC');
export const GALLERY_EVENTS_GRPC = Symbol('GALLERY_EVENTS_GRPC');
const CONFIG = Symbol('CONFIG');
const PRISMA = Symbol('PRISMA');
const MONGO = Symbol('MONGO');
const DEPS = Symbol('DEPS');

const clock = { now: () => new Date() };

interface Dependencies {
  galleries: PrismaGalleryRepository;
  social: MongoSocialStore;
  catalog: GrpcCatalogClient;
  callers: CallerResolver;
  clients: { identity: identityV1.IdentityServiceClient; catalog: catalogV1.CatalogServiceClient; ai: aiV1.AiServiceClient };
  tokens: ServiceTokenProvider;
}

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('gallery-service') },
  { provide: PRISMA, inject: [CONFIG], useFactory: (config: GalleryConfigEnv) => new PrismaClient({ datasourceUrl: config.DATABASE_URL }) },
  { provide: MONGO, inject: [CONFIG], useFactory: (config: GalleryConfigEnv) => new MongoClient(config.MONGODB_URI).connect() },
  {
    provide: DEPS,
    inject: [CONFIG, PRISMA, MONGO],
    useFactory: (config: GalleryConfigEnv, prisma: PrismaClient, mongo: MongoClient): Dependencies => {
      const channel = channelCredentials(config.tls);
      const identity = new identityV1.IdentityServiceClient(config.IDENTITY_GRPC_URL, channel);
      const catalog = new catalogV1.CatalogServiceClient(config.CATALOG_GRPC_URL, channel);
      const ai = new aiV1.AiServiceClient(config.AI_GRPC_URL, channel);
      const tokens = new ServiceTokenProvider(identity, config.SERVICE_CLIENT_ID, config.SERVICE_CLIENT_SECRET);
      return {
        galleries: new PrismaGalleryRepository(prisma),
        social: new MongoSocialStore(mongo.db(config.MONGODB_DATABASE)),
        catalog: new GrpcCatalogClient(catalog, tokens),
        callers: new CallerResolver(TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH)),
        clients: { identity, catalog, ai },
        tokens,
      };
    },
  },
  {
    provide: GALLERY_GRPC,
    inject: [DEPS, LOGGER],
    useFactory: (deps: Dependencies, logger: StructuredLogger): galleryV1.GalleryServiceServer =>
      galleryGrpcService(
        {
          personal: new PersonalGalleryUseCases(deps.galleries, new AiGalleryDesigner(deps.clients.ai, deps.tokens, logger), deps.catalog),
          social: new SocialUseCases(deps.galleries, deps.social, new GrpcIdentityClient(deps.clients.identity), clock),
        },
        deps.callers,
        logger,
      ),
  },
  {
    provide: GALLERY_EVENTS_GRPC,
    inject: [DEPS, LOGGER],
    useFactory: (deps: Dependencies, logger: StructuredLogger): galleryHandlersV1.GalleryEventHandlerServiceServer =>
      galleryEventsGrpcService(new GalleryEventHandlers(deps.galleries, deps.social, deps.catalog, clock), deps.callers, logger),
  },
];

@Module({})
export class GalleryModule implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MONGO) private readonly mongo: MongoClient,
    @Inject(DEPS) private readonly deps: Dependencies,
  ) {}

  static register(config: GalleryConfigEnv): DynamicModule {
    return {
      module: GalleryModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [LOGGER, GALLERY_GRPC, GALLERY_EVENTS_GRPC],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    for (const client of Object.values(this.deps.clients)) {
      client.close();
    }
    await this.mongo.close();
    await this.prisma.$disconnect();
  }
}
