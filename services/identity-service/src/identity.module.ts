import { readFileSync } from 'node:fs';
import { Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { createConnection, type Connection } from 'mongoose';
import { durationToMs, StructuredLogger, TokenVerifier } from '@artauction/platform';
import { PrismaClient } from './generated/prisma';
import { identityGrpcService, type IdentityUseCases } from './api/grpc/identity.grpc';
import { SessionIssuer } from './internal/application/session-issuer';
import {
  GetAccount,
  GetPublicProfile,
  GetSigningKeys,
  IssueServiceToken,
  Login,
  RegisterAccount,
  RotateRefreshSession,
  UpdateProfile,
} from './internal/application/use-cases';
import {
  Argon2PasswordHasher,
  EnvServiceClientRegistry,
  OpaqueRefreshTokenCodec,
  Rs256TokenIssuer,
  SystemClock,
  UuidGenerator,
} from './internal/infrastructure/crypto-adapters';
import { MongoSessionStore } from './internal/infrastructure/mongo-session.store';
import { PrismaAccountRepository } from './internal/infrastructure/prisma-account.repository';
import type { IdentityConfig } from './config';

// Raiz de composicion: el unico lugar que conoce a la vez los casos de uso, sus
// puertos y las implementaciones concretas.

export const CONFIG = Symbol('IDENTITY_CONFIG');
export const LOGGER = Symbol('LOGGER');
export const GRPC_SERVICE = Symbol('IDENTITY_GRPC_SERVICE');
const PRISMA = Symbol('PRISMA');
const MONGO = Symbol('MONGO');
const USE_CASES = Symbol('USE_CASES');

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('identity-service') },
  {
    provide: PRISMA,
    inject: [CONFIG],
    useFactory: (config: IdentityConfig) => new PrismaClient({ datasourceUrl: config.DATABASE_URL }),
  },
  {
    provide: MONGO,
    inject: [CONFIG],
    useFactory: async (config: IdentityConfig): Promise<Connection> =>
      createConnection(config.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 }).asPromise(),
  },
  {
    provide: USE_CASES,
    inject: [CONFIG, PRISMA, MONGO],
    useFactory: (config: IdentityConfig, prisma: PrismaClient, mongo: Connection): IdentityUseCases => {
      const accounts = new PrismaAccountRepository(prisma);
      const hasher = new Argon2PasswordHasher();
      const tokens = new Rs256TokenIssuer(
        readFileSync(config.JWT_PRIVATE_KEY_PATH, 'utf8'),
        config.JWT_ACCESS_TTL,
        config.SERVICE_TOKEN_TTL,
      );
      const store = new MongoSessionStore(mongo);
      const codec = new OpaqueRefreshTokenCodec();
      const clock = new SystemClock();
      const sessions = new SessionIssuer(tokens, codec, store, new UuidGenerator(), clock, durationToMs(config.JWT_REFRESH_TTL));
      return {
        register: new RegisterAccount(accounts, hasher),
        login: new Login(accounts, hasher, sessions),
        rotate: new RotateRefreshSession(accounts, store, codec, sessions, clock),
        getAccount: new GetAccount(accounts),
        updateProfile: new UpdateProfile(accounts),
        getPublicProfile: new GetPublicProfile(accounts),
        issueServiceToken: new IssueServiceToken(new EnvServiceClientRegistry(config.SERVICE_CLIENTS), tokens),
        getSigningKeys: new GetSigningKeys(tokens),
      };
    },
  },
  {
    provide: GRPC_SERVICE,
    inject: [CONFIG, USE_CASES, LOGGER],
    useFactory: (config: IdentityConfig, useCases: IdentityUseCases, logger: StructuredLogger) =>
      identityGrpcService(useCases, TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH), logger),
  },
];

@Module({})
export class IdentityModule implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MONGO) private readonly mongo: Connection,
  ) {}

  static register(config: IdentityConfig) {
    return {
      module: IdentityModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [GRPC_SERVICE, LOGGER],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.prisma.$disconnect(), this.mongo.close()]);
  }
}
