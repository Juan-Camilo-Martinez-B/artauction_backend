import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { AuctionBus } from './auction-bus';
import { centsToMoney, evaluateBid, moneyToCents, type BidRejection } from './bid-rules';

export interface PlacedBid {
  bidId: string;
  auctionId: string;
  amount: string;
  endsAt: string;
  extended: boolean;
  idempotent: boolean;
  currentPrice: string;
}

interface LockedAuction {
  id: string;
  status: string;
  current_price: Prisma.Decimal | string;
  min_increment: Prisma.Decimal | string;
  ends_at: Date;
  seller_id: string;
  lot_status: string;
}

@Injectable()
export class BidsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AuctionBus,
  ) {}

  async placeBid(input: {
    auctionId: string;
    bidderId: string;
    amount: string;
    idempotencyKey: string;
    now?: Date;
  }): Promise<PlacedBid> {
    const now = input.now ?? new Date();
    const amountCents = moneyToCents(input.amount);
    const placed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedAuction[]>(Prisma.sql`
        SELECT a.id::text AS id,
               a.status,
               a.current_price,
               a.min_increment,
               a.ends_at,
               l.seller_id::text AS seller_id,
               l.status AS lot_status
        FROM auctions a
        INNER JOIN lots l ON l.id = a.lot_id
        WHERE a.id = CAST(${input.auctionId} AS uuid)
        FOR UPDATE OF a, l
      `);
      const row = rows[0];
      if (!row) {
        throw new NotFoundException('Subasta no encontrada');
      }
      const existing = await tx.bid.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        const same =
          existing.bidderId === input.bidderId &&
          existing.auctionId === input.auctionId &&
          moneyToCents(existing.amount) === amountCents;
        if (!same) {
          throw new ConflictException('idempotencyKey reutilizada');
        }
        return {
          bidId: existing.id,
          auctionId: input.auctionId,
          amount: centsToMoney(amountCents),
          endsAt: row.ends_at.toISOString(),
          extended: false,
          idempotent: true,
          currentPrice: centsToMoney(moneyToCents(row.current_price)),
          bidderId: input.bidderId,
        };
      }
      const bidCount = await tx.bid.count({ where: { auctionId: input.auctionId } });
      const decision = evaluateBid({
        now,
        auctionStatus: row.status,
        lotStatus: row.lot_status,
        sellerId: row.seller_id,
        bidderId: input.bidderId,
        currentPriceCents: moneyToCents(row.current_price),
        minIncrementCents: moneyToCents(row.min_increment),
        hasBids: bidCount > 0,
        endsAt: row.ends_at,
        amountCents,
      });
      if (!decision.ok) {
        throw bidHttpError(decision.code);
      }
      const bid = await tx.bid.create({
        data: {
          auctionId: input.auctionId,
          bidderId: input.bidderId,
          amount: centsToMoney(amountCents),
          idempotencyKey: input.idempotencyKey,
        },
      });
      await tx.auction.update({
        where: { id: input.auctionId },
        data: {
          currentPrice: centsToMoney(amountCents),
          endsAt: decision.nextEndsAt,
          ...(decision.extended ? { extensionCount: { increment: 1 } } : {}),
        },
      });
      return {
        bidId: bid.id,
        auctionId: input.auctionId,
        amount: centsToMoney(amountCents),
        endsAt: decision.nextEndsAt.toISOString(),
        extended: decision.extended,
        idempotent: false,
        currentPrice: centsToMoney(amountCents),
        bidderId: input.bidderId,
      };
    });
    if (!placed.idempotent) {
      this.bus.bidAccepted({
        version: 1,
        auctionId: placed.auctionId,
        bidId: placed.bidId,
        bidderId: placed.bidderId,
        amount: placed.amount,
        endsAt: placed.endsAt,
        extended: placed.extended,
        serverTime: new Date().toISOString(),
      });
    }
    return {
      bidId: placed.bidId,
      auctionId: placed.auctionId,
      amount: placed.amount,
      endsAt: placed.endsAt,
      extended: placed.extended,
      idempotent: placed.idempotent,
      currentPrice: placed.currentPrice,
    };
  }
}

function bidHttpError(code: BidRejection): HttpException {
  switch (code) {
    case 'OWN_LOT':
      return new ForbiddenException('No puedes pujar por tu propia obra');
    case 'TOO_LOW':
      return new BadRequestException('La puja no alcanza el incremento mínimo');
    case 'NOT_ACTIVE':
      return new ConflictException('La subasta no está activa');
    case 'CLOSED':
      return new ConflictException('La subasta ya cerró');
  }
}
