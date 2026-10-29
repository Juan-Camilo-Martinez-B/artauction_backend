import { Inject, Module, type DynamicModule, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import type { notificationHandlersV1, notificationV1 } from '@artauction/contracts';
import { StructuredLogger, TokenVerifier } from '@artauction/platform';
import { CallerResolver } from '@artauction/service-kit';
import { MongoClient } from 'mongodb';
import { notificationEventsGrpcService, notificationGrpcService } from './api/grpc/notification.grpc';
import { ListNotifications, NotificationEvents } from './internal/application/use-cases';
import { MongoNotificationStore } from './internal/infrastructure/mongo-notification.store';
import type { NotificationConfig } from './config';

// Raiz de composicion de notification-service: solo Mongo, sin llamadas a otros servicios.

export const LOGGER = Symbol('LOGGER');
export const NOTIFICATION_GRPC = Symbol('NOTIFICATION_GRPC');
export const NOTIFICATION_EVENTS_GRPC = Symbol('NOTIFICATION_EVENTS_GRPC');
const CONFIG = Symbol('CONFIG');
const MONGO = Symbol('MONGO');
const STORE = Symbol('STORE');
const CALLERS = Symbol('CALLERS');

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('notification-service') },
  { provide: MONGO, inject: [CONFIG], useFactory: (config: NotificationConfig) => new MongoClient(config.MONGODB_URI).connect() },
  {
    provide: STORE,
    inject: [CONFIG, MONGO],
    useFactory: (config: NotificationConfig, mongo: MongoClient) => new MongoNotificationStore(mongo.db(config.MONGODB_DATABASE)),
  },
  {
    provide: CALLERS,
    inject: [CONFIG],
    useFactory: (config: NotificationConfig) => new CallerResolver(TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH)),
  },
  {
    provide: NOTIFICATION_GRPC,
    inject: [STORE, CALLERS, LOGGER],
    useFactory: (store: MongoNotificationStore, callers: CallerResolver, logger: StructuredLogger): notificationV1.NotificationServiceServer =>
      notificationGrpcService(new ListNotifications(store), callers, logger),
  },
  {
    provide: NOTIFICATION_EVENTS_GRPC,
    inject: [STORE, CALLERS, LOGGER],
    useFactory: (
      store: MongoNotificationStore,
      callers: CallerResolver,
      logger: StructuredLogger,
    ): notificationHandlersV1.NotificationEventHandlerServiceServer =>
      notificationEventsGrpcService(new NotificationEvents(store, { now: () => new Date() }), callers, logger),
  },
];

@Module({})
export class NotificationModule implements OnApplicationShutdown {
  constructor(@Inject(MONGO) private readonly mongo: MongoClient) {}

  static register(config: NotificationConfig): DynamicModule {
    return {
      module: NotificationModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [LOGGER, NOTIFICATION_GRPC, NOTIFICATION_EVENTS_GRPC],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.mongo.close();
  }
}
