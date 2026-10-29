import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { auditEventsV1, galleryHandlersV1, notificationHandlersV1, type commonV1 } from '@artauction/contracts';
import { DomainError, StructuredLogger, TokenVerifier } from '@artauction/platform';
import { CallerResolver, startGrpcServer, unary, type RunningServer } from '@artauction/service-kit';
import { ENV, type Environment } from '../common/config/environment';
import { OUTCOME_NOTIFIER, type OutcomeNotifier } from '../common/outcomes';
import { PrismaService } from '../infra/postgres/prisma.service';
import { GaleriasService } from '../modules/galerias-social/galerias.service';

/**
 * Transitorio (Strangler Fig): mientras gallery y notification no existan
 * como servicios, el monolito atiende sus contratos gRPC de eventos. Los
 * productores solo conocen una URL; cuando nazca cada servicio, la URL cambia y
 * la parte correspondiente de este archivo se borra. Las subastas las atiende
 * auction-service (F6) y la auditoria audit-service (F7).
 */
@Injectable()
export class LegacyGrpcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLogger('monolith-legacy-grpc');
  private server: RunningServer | null = null;

  constructor(
    @Inject(ENV) private readonly env: Environment,
    private readonly prisma: PrismaService,
    private readonly galleries: GaleriasService,
    @Inject(OUTCOME_NOTIFIER) private readonly notifier: OutcomeNotifier,
    @InjectConnection() private readonly mongo: Connection,
  ) {}

  async onModuleInit(): Promise<void> {
    const publicKey = this.env.identityPublicKey;
    if (this.env.LEGACY_GRPC_PORT === 0 || publicKey === null) {
      return;
    }
    const callers = new CallerResolver(new TokenVerifier(publicKey));
    this.server = await startGrpcServer({
      host: '127.0.0.1',
      port: this.env.LEGACY_GRPC_PORT,
      tls: { enabled: false },
      logger: this.logger,
      services: [
        {
          name: 'artauction.gallery.v1.GalleryEventHandlerService',
          definition: galleryHandlersV1.GalleryEventHandlerServiceService,
          implementation: this.galleryEvents(callers),
        },
        {
          name: 'artauction.notification.v1.NotificationEventHandlerService',
          definition: notificationHandlersV1.NotificationEventHandlerServiceService,
          implementation: this.notificationEvents(callers),
        },
      ],
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.server?.shutdown();
  }

  /**
   * Aplica un efecto una sola vez por evento. Los efectos del monolito escriben
   * en Mongo, fuera de una transaccion SQL, asi que el orden es:
   * comprobar, aplicar el efecto y despues registrarlo. Un fallo entre ambos
   * pasos solo puede repetir el efecto, nunca perderlo.
   */
  private async once(inbox: Inbox, metadata: commonV1.EventMetadata | undefined, type: string, effect: () => Promise<unknown>) {
    const eventId = metadata?.eventId;
    if (!eventId) {
      throw DomainError.invalid('El evento no trae event_id');
    }
    if (await inbox.seen(eventId)) {
      return;
    }
    await effect();
    await inbox.record(eventId, type);
  }

  /** Inbox SQL del esquema del consumidor futuro (gallery). */
  private sqlInbox(schema: 'gallery'): Inbox {
    return {
      seen: async (eventId) =>
        (await this.prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${schema}.inbox WHERE event_id = $1`, eventId)).length > 0,
      record: async (eventId, type) => {
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO ${schema}.inbox (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
          eventId,
          type,
        );
      },
    };
  }

  /** Inbox en Mongo para notificaciones (su servicio vivira en Mongo). */
  private mongoInbox(): Inbox {
    const events = this.mongo.collection<{ _id: string; type: string; processedAt: Date }>('processed_events');
    return {
      seen: async (eventId) => (await events.countDocuments({ _id: eventId }, { limit: 1 })) > 0,
      record: async (eventId, type) => {
        await events.updateOne({ _id: eventId }, { $setOnInsert: { type, processedAt: new Date() } }, { upsert: true });
      },
    };
  }

  private galleryEvents(callers: CallerResolver): galleryHandlersV1.GalleryEventHandlerServiceServer {
    return {
      handleLotCreated: unary(this.logger, 'HandleLotCreated', async (request, context) => {
        callers.service(context, ['catalog-service']);
        const event = request.event;
        if (event) {
          await this.once(this.sqlInbox('gallery'), event.metadata, 'catalog.LotCreated', () =>
            this.galleries.grantOwnLot({ ownerId: event.sellerId, lotId: event.lotId }),
          );
        }
        return galleryHandlersV1.HandleLotCreatedResponse.fromPartial({});
      }),
      handleAuctionClosed: unary(this.logger, 'HandleAuctionClosed', async (request, context) => {
        callers.service(context, ['auction-service']);
        const event = request.event;
        if (event?.winnerId) {
          await this.once(this.sqlInbox('gallery'), event.metadata, 'auction.AuctionClosed', () =>
            this.galleries.grantWonLot({ ownerId: event.winnerId, lotId: event.lotId }),
          );
        }
        return galleryHandlersV1.HandleAuctionClosedResponse.fromPartial({});
      }),
    };
  }

  private notificationEvents(callers: CallerResolver): notificationHandlersV1.NotificationEventHandlerServiceServer {
    return {
      handleAuctionClosed: unary(this.logger, 'HandleAuctionClosed', async (request, context) => {
        callers.service(context, ['auction-service']);
        const event = request.event;
        if (event) {
          await this.once(this.mongoInbox(), event.metadata, 'auction.AuctionClosed', () =>
            this.notifier.auctionClosed({
              auctionId: event.auctionId,
              lotId: event.lotId,
              sellerId: event.sellerId,
              winnerId: event.winnerId || null,
              amount: event.amount,
            }),
          );
        }
        return notificationHandlersV1.HandleAuctionClosedResponse.fromPartial({});
      }),
      // Desde F7 AuditCompleted lo produce audit-service.
      handleAuditCompleted: unary(this.logger, 'HandleAuditCompleted', async (request, context) => {
        callers.service(context, ['audit-service']);
        const event = request.event;
        if (event) {
          await this.once(this.mongoInbox(), event.metadata, 'audit.AuditCompleted', () =>
            this.notifier.auditFinished({
              lotId: event.lotId,
              sellerId: event.sellerId,
              verdict: event.verdict === auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED ? 'APROBADO' : 'REVISION_MANUAL',
            }),
          );
        }
        return notificationHandlersV1.HandleAuditCompletedResponse.fromPartial({});
      }),
    };
  }
}

interface Inbox {
  seen(eventId: string): Promise<boolean>;
  record(eventId: string, type: string): Promise<void>;
}
