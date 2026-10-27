import { status, type handleUnaryCall } from '@grpc/grpc-js';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  auctionHandlersV1,
  auctionV1,
  auditEventsV1,
  auditHandlersV1,
  auditV1,
  galleryHandlersV1,
  type commonV1,
} from '@artauction/contracts';
import { DomainError, StructuredLogger, TokenVerifier } from '@artauction/platform';
import { CallerResolver, startGrpcServer, unary, type RunningServer } from '@artauction/service-kit';
import { ENV, type Environment } from '../common/config/environment';
import { AuditQueue } from '../infra/queue/audit-queue';
import { PrismaService } from '../infra/postgres/prisma.service';
import { GaleriasService } from '../modules/galerias-social/galerias.service';
import { AuctionsService } from '../modules/subastas/auctions.service';

type InboxSchema = 'gallery' | 'audit' | 'auction';

/**
 * Transitorio (Strangler Fig): mientras gallery, audit y auction no existan
 * como servicios, el monolito atiende sus contratos gRPC de eventos y de
 * consulta. Los productores solo conocen una URL; cuando nazca cada servicio,
 * la URL cambia y este archivo se borra.
 */
@Injectable()
export class LegacyGrpcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLogger('monolith-legacy-grpc');
  private server: RunningServer | null = null;

  constructor(
    @Inject(ENV) private readonly env: Environment,
    private readonly prisma: PrismaService,
    private readonly galleries: GaleriasService,
    private readonly auctions: AuctionsService,
    private readonly audits: AuditQueue,
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
          name: 'artauction.auction.v1.AuctionEventHandlerService',
          definition: auctionHandlersV1.AuctionEventHandlerServiceService,
          implementation: this.auctionEvents(callers),
        },
        {
          name: 'artauction.auction.v1.AuctionService',
          definition: auctionV1.AuctionServiceService,
          implementation: this.auctionQueries(),
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
   * en Mongo o en pg-boss, fuera de la transaccion SQL, asi que el orden es:
   * comprobar el inbox, aplicar el efecto y despues registrarlo. Un fallo entre
   * ambos pasos solo puede repetir el efecto, nunca perderlo.
   */
  private async once(schema: InboxSchema, metadata: commonV1.EventMetadata | undefined, type: string, effect: () => Promise<unknown>): Promise<void> {
    const eventId = metadata?.eventId;
    if (!eventId) {
      throw DomainError.invalid('El evento no trae event_id');
    }
    const seen = await this.prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${schema}.inbox WHERE event_id = $1`, eventId);
    if (seen.length > 0) {
      return;
    }
    await effect();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ${schema}.inbox (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
      eventId,
      type,
    );
  }

  private galleryEvents(callers: CallerResolver): galleryHandlersV1.GalleryEventHandlerServiceServer {
    return {
      handleLotCreated: unary(this.logger, 'HandleLotCreated', async (request, context) => {
        callers.service(context, ['catalog-service']);
        const event = request.event;
        if (event) {
          await this.once('gallery', event.metadata, 'catalog.LotCreated', () =>
            this.galleries.grantOwnLot({ ownerId: event.sellerId, lotId: event.lotId }),
          );
        }
        return galleryHandlersV1.HandleLotCreatedResponse.fromPartial({});
      }),
      handleAuctionClosed: unimplemented('HandleAuctionClosed'),
    };
  }

  private auditEvents(callers: CallerResolver): auditHandlersV1.AuditEventHandlerServiceServer {
    return {
      handleLotSubmitted: unary(this.logger, 'HandleLotSubmitted', async (request, context) => {
        callers.service(context, ['catalog-service']);
        const event = request.event;
        if (event) {
          await this.once('audit', event.metadata, 'catalog.LotSubmitted', () => this.audits.enqueue(event.lotId));
        }
        return auditHandlersV1.HandleLotSubmittedResponse.fromPartial({});
      }),
    };
  }

  private auctionEvents(callers: CallerResolver): auctionHandlersV1.AuctionEventHandlerServiceServer {
    return {
      handleLotPublished: unary(this.logger, 'HandleLotPublished', async (request, context) => {
        callers.service(context, ['catalog-service']);
        const event = request.event;
        if (event) {
          await this.once('auction', event.metadata, 'catalog.LotPublished', () => this.auctions.scheduleFromLot(event.lotId));
        }
        return auctionHandlersV1.HandleLotPublishedResponse.fromPartial({});
      }),
      handleAuditCompleted: unimplemented('HandleAuditCompleted'),
    };
  }

  /** Resumenes publicos para que el gateway componga las fichas del catalogo. */
  private auctionQueries(): auctionV1.AuctionServiceServer {
    return {
      batchGetAuctionSummaries: unary(this.logger, 'BatchGetAuctionSummaries', async (request) => {
        const lotIds = uuids(request.lotIds);
        const rows = lotIds.length === 0 ? [] : await this.prisma.auction.findMany({ where: { lotId: { in: lotIds } } });
        return auctionV1.BatchGetAuctionSummariesResponse.fromPartial({
          summaries: rows.map((row) => ({
            auctionId: row.id,
            lotId: row.lotId,
            status: auctionStatus(row.status),
            currentPrice: row.currentPrice.toString(),
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            saleDescription: row.saleDescription ?? undefined,
            currency: row.currency,
          })),
        });
      }),
      getAuction: unimplemented('GetAuction'),
      openAuction: unimplemented('OpenAuction'),
      placeBid: unimplemented('PlaceBid'),
      withdrawBid: unimplemented('WithdrawBid'),
      getBidByReservation: unimplemented('GetBidByReservation'),
      watchAuction: (call) => {
        call.emit('error', { code: status.UNIMPLEMENTED, details: 'WatchAuction sigue en Socket.IO del monolito' });
      },
    };
  }

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuids(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => UUID.test(id)).slice(0, 100);
}

function auctionStatus(value: string): auctionV1.AuctionStatus {
  switch (value) {
    case 'ACTIVA':
      return auctionV1.AuctionStatus.AUCTION_STATUS_ACTIVA;
    case 'CERRADA':
      return auctionV1.AuctionStatus.AUCTION_STATUS_CERRADA;
    default:
      return auctionV1.AuctionStatus.AUCTION_STATUS_PROGRAMADA;
  }
}

function unimplemented<Req, Res>(rpc: string): handleUnaryCall<Req, Res> {
  return (_call, callback) => {
    const details = `${rpc} no esta disponible en el monolito`;
    callback(Object.assign(new Error(details), { code: status.UNIMPLEMENTED, details }));
  };
}
