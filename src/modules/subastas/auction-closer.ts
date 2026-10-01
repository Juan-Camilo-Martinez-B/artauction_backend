import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV, type Environment } from '../../common/config/environment';
import { GALLERY_GRANTS, OUTCOME_NOTIFIER, type GalleryGrants, type OutcomeNotifier } from '../../common/outcomes';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { AuctionBus } from './auction-bus';
import { centsToMoney, moneyToCents } from './bid-rules';

interface LockedClose {
  id: string;
  status: string;
  ends_at: Date;
  lot_id: string;
  seller_id: string;
  current_price: { toFixed(digits: number): string } | string;
  currency: string;
}

@Injectable()
export class AuctionCloser implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: AuctionBus,
    @Inject(ENV) private readonly env: Environment,
    @Optional() @Inject(GALLERY_GRANTS) private readonly grants?: GalleryGrants,
    @Optional() @Inject(OUTCOME_NOTIFIER) private readonly notifier?: OutcomeNotifier,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick(new Date());
    }, 5_000);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async tick(now: Date): Promise<void> {
    await this.openDue(now);
    await this.closeDue(now);
  }

  async openDue(now: Date): Promise<void> {
    const due = await this.prisma.auction.findMany({
      where: { status: 'PROGRAMADA', startsAt: { lte: now } },
      take: 20,
    });
    for (const auction of due) {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.auction.findUnique({ where: { id: auction.id } });
        const lot = current ? await tx.lot.findUnique({ where: { id: current.lotId } }) : null;
        if (!current || current.status !== 'PROGRAMADA' || !lot || lot.status !== 'APROBADO') {
          return;
        }
        await tx.auction.update({ where: { id: current.id }, data: { status: 'ACTIVA' } });
        await tx.lot.update({ where: { id: lot.id }, data: { status: 'EN_SUBASTA' } });
      });
    }
  }

  async closeDue(now: Date): Promise<void> {
    const due = await this.prisma.auction.findMany({
      where: { status: 'ACTIVA', endsAt: { lte: now } },
      take: 20,
    });
    for (const auction of due) {
      await this.closeOne(auction.id, now);
    }
  }

  async closeOne(auctionId: string, now: Date): Promise<boolean> {
    const closed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedClose[]>`
        SELECT a.id::text AS id,
               a.status,
               a.ends_at,
               a.current_price,
               a.currency,
               l.id::text AS lot_id,
               l.seller_id::text AS seller_id
        FROM auctions a
        INNER JOIN lots l ON l.id = a.lot_id
        WHERE a.id = CAST(${auctionId} AS uuid)
        FOR UPDATE OF a, l
      `;
      const row = rows[0];
      if (!row || row.status !== 'ACTIVA' || row.ends_at.getTime() > now.getTime()) {
        return null;
      }
      const winning = await tx.bid.findFirst({
        where: { auctionId },
        orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }],
      });
      const amount = centsToMoney(moneyToCents(winning ? winning.amount : row.current_price));
      await tx.auction.update({
        where: { id: auctionId },
        data: {
          status: 'CERRADA',
          winnerId: winning?.bidderId,
          winningBidId: winning?.id,
          currentPrice: amount,
        },
      });
      await tx.lot.update({ where: { id: row.lot_id }, data: { status: 'CERRADO' } });
      if (winning) {
        await tx.transaction.create({
          data: {
            auctionId,
            lotId: row.lot_id,
            buyerId: winning.bidderId,
            sellerId: row.seller_id,
            amount: winning.amount,
            currency: row.currency,
            status: 'PENDIENTE',
          },
        });
      }
      return {
        auctionId,
        lotId: row.lot_id,
        sellerId: row.seller_id,
        winnerId: winning?.bidderId ?? null,
        amount,
      };
    });
    if (!closed) {
      return false;
    }
    if (closed.winnerId) {
      await this.grants?.grantWonLot({ ownerId: closed.winnerId, lotId: closed.lotId });
    }
    await this.notifier?.auctionClosed(closed);
    this.bus.auctionClosed({
      version: 1,
      auctionId: closed.auctionId,
      lotId: closed.lotId,
      winnerId: closed.winnerId,
      amount: closed.amount,
      serverTime: new Date().toISOString(),
    });
    return true;
  }
}
