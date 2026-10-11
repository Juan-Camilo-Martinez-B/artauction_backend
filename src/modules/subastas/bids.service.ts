import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InsufficientCoinsError, releaseHold, retainCoins } from '../bolsillo/ledger';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { AuctionBus } from './auction-bus';
import { amountTakenMessage, canWithdraw, publishedAmount } from './auction-policy';
import { BidLane } from './bid-lane';
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
  start_price: Prisma.Decimal | string;
  min_increment: Prisma.Decimal | string;
  ends_at: Date;
  seller_id: string;
  lot_status: string;
}

@Injectable()
export class BidsService {
  private readonly lane = new BidLane();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AuctionBus,
  ) {}

  placeBid(input: {
    auctionId: string;
    bidderId: string;
    amount: string;
    idempotencyKey: string;
    now?: Date;
  }): Promise<PlacedBid> {
    return this.lane.run(input.auctionId, () => this.placeLocked(input));
  }

  withdraw(input: { auctionId: string; bidderId: string; now?: Date }) {
    return this.lane.run(input.auctionId, () => this.withdrawLocked(input));
  }

  private async placeLocked(input: {
    auctionId: string;
    bidderId: string;
    amount: string;
    idempotencyKey: string;
    now?: Date;
  }): Promise<PlacedBid> {
    const now = input.now ?? new Date();
    const amountCents = moneyToCents(input.amount);
    if (amountCents <= 0 || amountCents % 100 !== 0) {
      throw new BadRequestException('Las artacoins se ofertan en enteros.');
    }
    const placed = await this.prisma.$transaction(async (tx) => {
      const row = await lockAuction(tx, input.auctionId);
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
      const taken = await tx.$queryRaw<{ bidder_id: string }[]>`
        SELECT bidder_id::text AS bidder_id
        FROM bids
        WHERE auction_id = CAST(${input.auctionId} AS uuid)
          AND active
          AND amount = CAST(${centsToMoney(amountCents)} AS numeric)
        LIMIT 1
      `;
      const owner = taken[0]?.bidder_id;
      if (owner && owner !== input.bidderId) {
        throw new ConflictException(amountTakenMessage(amountCents));
      }
      if (owner === input.bidderId) {
        throw new ConflictException(`Ya publicaste la oferta de ${publishedAmount(amountCents)}.`);
      }
      const bidCount = await tx.bid.count({ where: { auctionId: input.auctionId, active: true } });
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
      try {
        await retainCoins(tx, {
          userId: input.bidderId,
          auctionId: input.auctionId,
          nextCoins: amountCents / 100,
        });
      } catch (error) {
        if (error instanceof InsufficientCoinsError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
      await tx.bid.updateMany({
        where: { auctionId: input.auctionId, bidderId: input.bidderId, active: true },
        data: { active: false },
      });
      const bid = await tx.bid.create({
        data: {
          auctionId: input.auctionId,
          bidderId: input.bidderId,
          amount: centsToMoney(amountCents),
          idempotencyKey: input.idempotencyKey,
          active: true,
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

  private async withdrawLocked(input: { auctionId: string; bidderId: string; now?: Date }) {
    const now = input.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await lockAuction(tx, input.auctionId);
      if (row.status !== 'ACTIVA' || row.lot_status !== 'EN_SUBASTA') {
        throw new ConflictException('La subasta no está activa');
      }
      if (!canWithdraw(now, row.ends_at)) {
        throw new ConflictException('No puedes retirarte durante los últimos 4 minutos de la subasta.');
      }
      const mine = await tx.bid.findFirst({
        where: { auctionId: input.auctionId, bidderId: input.bidderId, active: true },
        orderBy: { amount: 'desc' },
      });
      if (!mine) {
        throw new BadRequestException('No tienes una oferta activa en esta sala.');
      }
      const leading = moneyToCents(mine.amount) >= moneyToCents(row.current_price);
      await tx.$executeRaw`SELECT set_config('artauction.allow_auction_rewind', 'on', true)`;
      await tx.bid.updateMany({
        where: { auctionId: input.auctionId, bidderId: input.bidderId, active: true },
        data: { active: false },
      });
      const released = await releaseHold(tx, { userId: input.bidderId, auctionId: input.auctionId });
      let currentPrice = centsToMoney(moneyToCents(row.current_price));
      if (leading) {
        const next = await tx.bid.findFirst({
          where: { auctionId: input.auctionId, active: true },
          orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }],
        });
        currentPrice = centsToMoney(moneyToCents(next ? next.amount : row.start_price));
        await tx.auction.update({
          where: { id: input.auctionId },
          data: { currentPrice },
        });
      }
      return { auctionId: input.auctionId, released, currentPrice };
    });
  }
}

async function lockAuction(tx: Prisma.TransactionClient, auctionId: string): Promise<LockedAuction> {
  const rows = await tx.$queryRaw<LockedAuction[]>`
    SELECT a.id::text AS id,
           a.status,
           a.current_price,
           a.start_price,
           a.min_increment,
           a.ends_at,
           l.seller_id::text AS seller_id,
           l.status AS lot_status
    FROM auctions a
    INNER JOIN lots l ON l.id = a.lot_id
    WHERE a.id = CAST(${auctionId} AS uuid)
    FOR UPDATE OF a, l
  `;
  const row = rows[0];
  if (!row) {
    throw new NotFoundException('Subasta no encontrada');
  }
  return row;
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
