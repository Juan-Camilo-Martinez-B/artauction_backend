import { appendToOutbox, recordInbox, sqlExecutorFrom, type DomainEvent } from '@artauction/platform';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Auction, Bid } from '../domain/auction';
import type { AuctionStatus } from '../domain/auction-rules';
import type { AuctionPatch, AuctionRepository, AuctionUnitOfWork, NewAuction } from '../application/ports';

export const AUCTION_SCHEMA = 'auction';

type Tx = Prisma.TransactionClient;
type AuctionRow = Prisma.AuctionGetPayload<object>;
type BidRow = Prisma.BidGetPayload<object>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: ReadonlySet<string> = new Set(['PROGRAMADA', 'ACTIVA', 'CERRADA']);

function toAuction(row: AuctionRow): Auction {
  if (!STATUSES.has(row.status)) {
    throw new Error(`Estado desconocido en auction.auctions: ${row.status}`);
  }
  if (row.sellerId === null) {
    // La migracion 0018 rellena el vendedor; una fila sin el no puede validar pujas.
    throw new Error(`La subasta ${row.id} no tiene vendedor`);
  }
  return {
    id: row.id,
    lotId: row.lotId,
    sellerId: row.sellerId,
    lotTitle: row.lotTitle ?? '',
    startPrice: row.startPrice.toFixed(2),
    currentPrice: row.currentPrice.toFixed(2),
    minIncrement: row.minIncrement.toFixed(2),
    currency: row.currency,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    initialEndsAt: row.initialEndsAt,
    status: row.status as AuctionStatus,
    winnerId: row.winnerId,
    extensionCount: row.extensionCount,
    durationMinutes: row.durationMinutes,
    saleDescription: row.saleDescription,
  };
}

function toBid(row: BidRow): Bid {
  return {
    id: row.id,
    auctionId: row.auctionId,
    bidderId: row.bidderId,
    amount: row.amount.toFixed(2),
    active: row.active,
    createdAt: row.createdAt,
  };
}

function patchData(patch: AuctionPatch): Prisma.AuctionUpdateInput {
  const data: Prisma.AuctionUpdateInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.currentPrice !== undefined) data.currentPrice = patch.currentPrice;
  if (patch.startsAt !== undefined) data.startsAt = patch.startsAt;
  if (patch.endsAt !== undefined) data.endsAt = patch.endsAt;
  if (patch.initialEndsAt !== undefined) data.initialEndsAt = patch.initialEndsAt;
  if (patch.extensionCountIncrement) data.extensionCount = { increment: 1 };
  if (patch.resetExtensions) data.extensionCount = 0;
  if (patch.winnerId !== undefined) data.winnerId = patch.winnerId;
  if (patch.winningBidId !== undefined) data.winningBidId = patch.winningBidId;
  return data;
}

function unitOfWork(tx: Tx): AuctionUnitOfWork {
  return {
    async lock(auctionId, options = {}) {
      if (!UUID.test(auctionId)) {
        return null;
      }
      const rows = options.skipLocked
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id::text AS id FROM auction.auctions WHERE id = CAST(${auctionId} AS uuid) FOR UPDATE SKIP LOCKED`
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id::text AS id FROM auction.auctions WHERE id = CAST(${auctionId} AS uuid) FOR UPDATE`;
      if (rows.length === 0) {
        return null;
      }
      return toAuction(await tx.auction.findUniqueOrThrow({ where: { id: auctionId } }));
    },
    async bidByKey(idempotencyKey) {
      const row = await tx.bid.findUnique({ where: { idempotencyKey } });
      return row ? toBid(row) : null;
    },
    activeBidCount(auctionId) {
      return tx.bid.count({ where: { auctionId, active: true } });
    },
    async activeBidderAt(auctionId, amount) {
      const row = await tx.bid.findFirst({ where: { auctionId, active: true, amount } });
      return row?.bidderId ?? null;
    },
    async topActiveBid(auctionId) {
      const row = await tx.bid.findFirst({
        where: { auctionId, active: true },
        orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }],
      });
      return row ? toBid(row) : null;
    },
    async bidderActiveBid(auctionId, bidderId) {
      const row = await tx.bid.findFirst({ where: { auctionId, bidderId, active: true }, orderBy: { amount: 'desc' } });
      return row ? toBid(row) : null;
    },
    async insertBid(bid) {
      return toBid(await tx.bid.create({ data: { ...bid, active: true } }));
    },
    async deactivateBids(auctionId, bidderId) {
      await tx.bid.updateMany({ where: { auctionId, active: true, ...(bidderId ? { bidderId } : {}) }, data: { active: false } });
    },
    async allowPriceRewind() {
      // El trigger auctions_reject_backward_update permite bajar el precio solo
      // con esta variable. El tercer argumento la limita a esta transaccion.
      await tx.$executeRaw`SELECT set_config('artauction.allow_auction_rewind', 'on', true)`;
    },
    async update(auctionId, patch) {
      await tx.auction.update({ where: { id: auctionId }, data: patchData(patch) });
    },
    async recordSale(sale) {
      await tx.sale.create({ data: { ...sale, status: 'COMPLETADA' } });
    },
    async createIfAbsent(auction) {
      if (await tx.auction.findUnique({ where: { lotId: auction.lotId }, select: { id: true } })) {
        return null;
      }
      return toAuction(await tx.auction.create({ data: newAuctionData(auction) }));
    },
    async emit(events: DomainEvent[]) {
      await appendToOutbox(sqlExecutorFrom(tx), AUCTION_SCHEMA, events);
    },
  };
}

export class PrismaAuctionRepository implements AuctionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  transaction<T>(work: (uow: AuctionUnitOfWork) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(unitOfWork(tx)));
  }

  applyOnce<T>(eventId: string, eventType: string, work: (uow: AuctionUnitOfWork) => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await recordInbox(sqlExecutorFrom(tx), AUCTION_SCHEMA, eventId, eventType))) {
        return null;
      }
      return work(unitOfWork(tx));
    });
  }

  async findById(auctionId: string): Promise<Auction | null> {
    if (!UUID.test(auctionId)) {
      return null;
    }
    const row = await this.prisma.auction.findUnique({ where: { id: auctionId } });
    return row ? toAuction(row) : null;
  }

  async findByLotId(lotId: string): Promise<Auction | null> {
    if (!UUID.test(lotId)) {
      return null;
    }
    const row = await this.prisma.auction.findUnique({ where: { lotId } });
    return row ? toAuction(row) : null;
  }

  async findByLotIds(lotIds: readonly string[]): Promise<Auction[]> {
    const ids = lotIds.filter((id) => UUID.test(id));
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.auction.findMany({ where: { lotId: { in: ids } } });
    return rows.map(toAuction);
  }

  async recentBids(auctionId: string, limit: number): Promise<Bid[]> {
    const rows = await this.prisma.bid.findMany({ where: { auctionId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(toBid);
  }

  async bidByKey(idempotencyKey: string): Promise<Bid | null> {
    const row = await this.prisma.bid.findUnique({ where: { idempotencyKey } });
    return row ? toBid(row) : null;
  }

  async create(auction: NewAuction, events: (auction: Auction) => DomainEvent[]): Promise<Auction | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = toAuction(await tx.auction.create({ data: newAuctionData(auction) }));
        await appendToOutbox(sqlExecutorFrom(tx), AUCTION_SCHEMA, events(created));
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  async dueToOpen(now: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.auction.findMany({
      where: { status: 'PROGRAMADA', startsAt: { lte: now } },
      select: { id: true },
      orderBy: { startsAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async dueToClose(now: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.auction.findMany({
      where: { status: 'ACTIVA', endsAt: { lte: now } },
      select: { id: true },
      orderBy: { endsAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }
}

function newAuctionData(auction: NewAuction): Prisma.AuctionCreateInput {
  return {
    lotId: auction.lotId,
    sellerId: auction.sellerId,
    lotTitle: auction.lotTitle,
    startPrice: auction.startPrice,
    currentPrice: auction.startPrice,
    minIncrement: auction.minIncrement,
    currency: 'ATC',
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    initialEndsAt: auction.endsAt,
    status: 'PROGRAMADA',
    durationMinutes: auction.durationMinutes,
    saleDescription: auction.saleDescription,
  };
}
