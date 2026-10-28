import { status, type handleUnaryCall } from '@grpc/grpc-js';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  auditEventsV1,
  auditHandlersV1,
  auditV1,
  galleryHandlersV1,
  notificationHandlersV1,
  type commonV1,
} from '@artauction/contracts';
import { DomainError, StructuredLogger, TokenVerifier } from '@artauction/platform';
import { CallerResolver, startGrpcServer, unary, type RunningServer } from '@artauction/service-kit';
import { ENV, type Environment } from '../common/config/environment';
import { OUTCOME_NOTIFIER, type OutcomeNotifier } from '../common/outcomes';
import { AuditQueue } from '../infra/queue/audit-queue';
import { PrismaService } from '../infra/postgres/prisma.service';
import { GaleriasService } from '../modules/galerias-social/galerias.service';

/**
 * Transitorio (Strangler Fig): mientras gallery, audit y notification no
 * existan como servicios, el monolito atiende sus contratos gRPC de eventos y
 * de consulta. Los productores solo conocen una URL; cuando nazca cada
 * servicio, la URL cambia y la parte correspondiente de este archivo se borra.
 * Las subastas ya las atiende auction-service (F6).
 */
@Injectable()
export class LegacyGrpcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLogger('monolith-legacy-grpc');
  private server: RunningServer | null = null;

  constructor(
    @Inject(ENV) private readonly env: Environment,
    private readonly prisma: PrismaService,
    private readonly galleries: GaleriasService,
    private readonly audits: AuditQueue,
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
          name: 'artauction.audit.v1.AuditEventHandlerService',
          definition: auditHandlersV1.AuditEventHandlerServiceService,
          implementation: this.auditEvents(callers),
        },
        {
          name: 'artauction.notification.v1.NotificationEventHandlerService',
          definition: notificationHandlersV1.NotificationEventHandlerServiceService,
          implementation: this.notificationEvents(callers),
        },
        {
          name: 'artauction.audit.v1.AuditService',
          definition: auditV1.AuditServiceService,
          implementation: this.auditQueries(),
        },
      ],
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.server?.shutdown();
  }

  /**
   * Aplica un efecto una sola vez por evento. Los efectos del monolito escriben
   * en Mongo o en pg-boss, fuera de una transaccion SQL, asi que el orden es:
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

  /** Inbox SQL del esquema del consumidor futuro (gallery, audit). */
  private sqlInbox(schema: 'gallery' | 'audit'): Inbox {
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

  private auditEvents(callers: CallerResolver): auditHandlersV1.AuditEventHandlerServiceServer {
    return {
      handleLotSubmitted: unary(this.logger, 'HandleLotSubmitted', async (request, context) => {
        callers.service(context, ['catalog-service']);
        const event = request.event;
        if (event) {
          await this.once(this.sqlInbox('audit'), event.metadata, 'catalog.LotSubmitted', () => this.audits.enqueue(event.lotId));
        }
        return auditHandlersV1.HandleLotSubmittedResponse.fromPartial({});
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
      // AuditCompleted lo produce la auditoria del propio monolito hasta F7.
      handleAuditCompleted: unimplemented('HandleAuditCompleted'),
    };
  }

  /** Ultimo informe de auditoria por obra, para que el gateway componga la ficha. */
  private auditQueries(): auditV1.AuditServiceServer {
    return {
      batchGetLatestSummaries: unary(this.logger, 'BatchGetLatestSummaries', async (request) => {
        const lotIds = uuids(request.lotIds);
        const rows =
          lotIds.length === 0
            ? []
            : await this.prisma.auditSummary.findMany({
                where: { lotId: { in: lotIds } },
                orderBy: { createdAt: 'desc' },
                distinct: ['lotId'],
              });
        return auditV1.BatchGetLatestSummariesResponse.fromPartial({
          summaries: rows.map((row) => ({
            id: row.id,
            lotId: row.lotId,
            score: row.score,
            priceMin: row.priceMin.toString(),
            priceMax: row.priceMax.toString(),
            verdict:
              row.verdict === 'APROBADO'
                ? auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED
                : auditEventsV1.AuditVerdict.AUDIT_VERDICT_MANUAL_REVIEW,
            hasCriticalInconsistency: row.hasCriticalInconsistency,
            modelName: row.modelName,
            promptVersion: row.promptVersion,
            createdAt: row.createdAt,
          })),
        });
      }),
    };
  }
}

interface Inbox {
  seen(eventId: string): Promise<boolean>;
  record(eventId: string, type: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuids(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => UUID.test(id)).slice(0, 100);
}

function unimplemented<Req, Res>(rpc: string): handleUnaryCall<Req, Res> {
  return (_call, callback) => {
    const details = `${rpc} no esta disponible en el monolito`;
    callback(Object.assign(new Error(details), { code: status.UNIMPLEMENTED, details }));
  };
}
