import { readFileSync } from 'node:fs';
import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type Provider } from '@nestjs/common';
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
  PurgeExpiredSessions,
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
import { PrismaAccountRepository } from './internal/infrastructure/prisma-account.repository';
import { PrismaSessionStore } from './internal/infrastructure/prisma-session.store';
import type { IdentityConfig } from './config';

// Raiz de composicion: el unico lugar que conoce a la vez los casos de uso, sus
// puertos y las implementaciones concretas.

export const CONFIG = Symbol('IDENTITY_CONFIG');
export const LOGGER = Symbol('LOGGER');
export const GRPC_SERVICE = Symbol('IDENTITY_GRPC_SERVICE');
const PRISMA = Symbol('PRISMA');
const SWEEPER = Symbol('SESSION_SWEEPER');
const USE_CASES = Symbol('USE_CASES');

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('identity-service') },
  {
    provide: PRISMA,
    inject: [CONFIG],
    useFactory: (config: IdentityConfig) => new PrismaClient({ datasourceUrl: config.DATABASE_URL }),
  },
  {
    provide: SWEEPER,
    inject: [PRISMA],
    useFactory: (prisma: PrismaClient) => new PurgeExpiredSessions(new PrismaSessionStore(prisma), new SystemClock()),
  },
  {
    provide: USE_CASES,
    inject: [CONFIG, PRISMA],
    useFactory: (config: IdentityConfig, prisma: PrismaClient): IdentityUseCases => {
      const accounts = new PrismaAccountRepository(prisma);
      const hasher = new Argon2PasswordHasher();
      const tokens = new Rs256TokenIssuer(
        readFileSync(config.JWT_PRIVATE_KEY_PATH, 'utf8'),
        config.JWT_ACCESS_TTL,
        config.SERVICE_TOKEN_TTL,
      );
      const store = new PrismaSessionStore(prisma);
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
export class IdentityModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(CONFIG) private readonly config: IdentityConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SWEEPER) private readonly sweeper: PurgeExpiredSessions,
    @Inject(LOGGER) private readonly logger: StructuredLogger,
  ) {}

  static register(config: IdentityConfig) {
    return {
      module: IdentityModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [GRPC_SERVICE, LOGGER],
    };
  }

  onApplicationBootstrap(): void {
    if (!this.config.SESSION_SWEEP_ENABLED) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.config.SESSION_SWEEP_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.prisma.$disconnect();
  }

  /** Un barrido a la vez; un fallo se registra y el siguiente lo reintenta. */
  private async sweep(): Promise<void> {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    try {
      const removed = await this.sweeper.execute();
      if (removed > 0) {
        this.logger.log(`sesiones vencidas borradas: ${String(removed)}`, 'sessions');
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error), undefined, 'sessions');
    } finally {
      this.sweeping = false;
    }
  }
}
