import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV, type Environment } from '../../common/config/environment';
import { GALLERY_GRANTS, OUTCOME_NOTIFIER, type GalleryGrants, type OutcomeNotifier } from '../../common/outcomes';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { settleHolds } from '../bolsillo/ledger';
import { AuctionBus } from './auction-bus';
import { scheduleWindow } from './auction-policy';
import { centsToMoney, moneyToCents } from './bid-rules';

interface LockedClose {
  id: string;
  status: string;
  ends_at: Date;
  lot_id: string;
  seller_id: string;
  current_price: { toFixed(digits: number): string } | string;
  currency: string;
  start_price: { toFixed(digits: number): string } | string;
  duration_minutes: number;
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
    if (this.env.NODE_ENV === 'test' || this.env.AUCTIONS_IN_SERVICE) {
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
        if (!current || current.status !== 'PROGRAMADA' || !lot || !['APROBADO', 'PUBLICADA'].includes(lot.status)) {
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
               a.start_price,
               a.duration_minutes,
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
        where: { auctionId, active: true },
        orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }],
      });
      if (!winning) {
        await tx.$executeRaw`SELECT set_config('artauction.allow_auction_rewind', 'on', true)`;
        const window = scheduleWindow(now, row.duration_minutes);
        await tx.bid.updateMany({ where: { auctionId, active: true }, data: { active: false } });
        await tx.auction.update({
          where: { id: auctionId },
          data: {
            status: 'PROGRAMADA',
            currentPrice: centsToMoney(moneyToCents(row.start_price)),
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            initialEndsAt: window.endsAt,
            extensionCount: 0,
            winnerId: null,
            winningBidId: null,
          },
        });
        await tx.lot.update({
          where: { id: row.lot_id },
          data: { status: 'PUBLICADA', visibility: 'PUBLIC' },
        });
        await settleHolds(tx, { auctionId, winnerId: null });
        return {
          auctionId,
          lotId: row.lot_id,
          sellerId: row.seller_id,
          winnerId: null,
          amount: centsToMoney(moneyToCents(row.start_price)),
          rescheduled: true,
        };
      }
      const amount = centsToMoney(moneyToCents(winning.amount));
      await tx.auction.update({
        where: { id: auctionId },
        data: {
          status: 'CERRADA',
          winnerId: winning.bidderId,
          winningBidId: winning.id,
          currentPrice: amount,
        },
      });
      await tx.lot.update({
        where: { id: row.lot_id },
        data: { status: 'VENDIDA', visibility: 'PRIVATE' },
      });
      await settleHolds(tx, { auctionId, winnerId: winning.bidderId });
      await tx.transaction.create({
        data: {
          auctionId,
          lotId: row.lot_id,
          buyerId: winning.bidderId,
          sellerId: row.seller_id,
          amount: winning.amount,
          currency: row.currency,
          status: 'COMPLETADA',
        },
      });
      return {
        auctionId,
        lotId: row.lot_id,
        sellerId: row.seller_id,
        winnerId: winning.bidderId,
        amount,
        rescheduled: false,
      };
    });
    if (!closed) {
      return false;
    }
    if (closed.rescheduled || !closed.winnerId) {
      return true;
    }
    await this.grants?.grantWonLot({ ownerId: closed.winnerId, lotId: closed.lotId });
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
