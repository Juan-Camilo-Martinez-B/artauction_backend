import { DomainError } from '@artauction/platform';
import { auctionClosed, auctionRescheduled, auctionStarted, type Auction } from '../domain/auction';
import {
  clampDuration,
  durationMinutes,
  incrementCoins,
  openingCoins,
  saleDescription,
  scheduleWindow,
} from '../domain/auction-rules';
import { assertWholeCoins, fromCents, toCents } from '../domain/money';
import type { AuctionRepository, CatalogPort, Clock, LiveFeed } from './ports';

const SCHEDULABLE_LOT_STATUSES = new Set(['APROBADO', 'PUBLICADA']);

/** Apertura manual de un vendedor sobre una obra suya ya publicada. */
export class OpenAuction {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly catalog: CatalogPort,
    private readonly clock: Clock,
  ) {}

  async execute(
    actor: { userId: string; role: string },
    input: { lotId: string; startPrice: string; minIncrement: string; startsAt: Date; endsAt: Date },
  ): Promise<Auction> {
    if (actor.role !== 'SELLER' && actor.role !== 'ADMIN') {
      throw DomainError.forbidden('Solo un vendedor abre subastas');
    }
    const now = this.clock.now();
    if (Number.isNaN(input.startsAt.getTime()) || Number.isNaN(input.endsAt.getTime()) || input.endsAt <= input.startsAt) {
      throw DomainError.invalid('El cierre debe ser posterior al inicio');
    }
    if (input.startsAt.getTime() <= now.getTime()) {
      throw DomainError.invalid('La subasta no puede empezar en el pasado.');
    }
    const startCents = toCents(input.startPrice);
    const incrementCents = toCents(input.minIncrement);
    assertWholeCoins(startCents);
    assertWholeCoins(incrementCents);
    const lot = await this.catalog.lot(input.lotId);
    if (!lot || lot.sellerId !== actor.userId) {
      throw DomainError.notFound('Obra no encontrada');
    }
    if (!SCHEDULABLE_LOT_STATUSES.has(lot.status)) {
      throw DomainError.precondition('La obra no esta lista para subastarse');
    }
    const created = await this.auctions.create(
      {
        lotId: lot.lotId,
        sellerId: lot.sellerId,
        lotTitle: lot.title,
        startPrice: fromCents(startCents),
        minIncrement: fromCents(incrementCents),
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        durationMinutes: clampDuration((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000),
        saleDescription: null,
      },
      () => [],
    );
    if (!created) {
      throw DomainError.conflict('Esa obra ya tiene subasta');
    }
    return created;
  }
}

/**
 * Programa la subasta de una obra aprobada (por auditoria o revision manual).
 * Los terminos salen del score y del rango de precio; si la obra ya tenia
 * subasta no hace nada. Idempotente por event id.
 */
export class ScheduleApprovedLot {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly clock: Clock,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(event: {
    eventId: string;
    eventType: string;
    lotId: string;
    sellerId: string;
    title: string;
    score: number;
    priceMin: number;
    priceMax: number;
    rationale: string;
  }): Promise<Auction | null> {
    const minutes = durationMinutes(event.score);
    const opening = openingCoins(event.priceMin, event.priceMax);
    const window = scheduleWindow(this.clock.now(), minutes, this.random);
    return this.auctions.applyOnce(event.eventId, event.eventType, (uow) =>
      uow.createIfAbsent({
        lotId: event.lotId,
        sellerId: event.sellerId,
        lotTitle: event.title,
        startPrice: fromCents(opening * 100),
        minIncrement: fromCents(incrementCoins(opening) * 100),
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        durationMinutes: minutes,
        saleDescription: saleDescription(event.title, event.rationale),
      }),
    );
  }
}

/**
 * Planificador: abre las subastas cuya hora llego y cierra las vencidas. Cada
 * subasta se procesa en su propia transaccion con FOR UPDATE SKIP LOCKED, asi
 * varias instancias no procesan la misma sala.
 */
export class RunScheduler {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly live: LiveFeed,
    private readonly clock: Clock,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(limit = 20): Promise<{ opened: number; closed: number; rescheduled: number }> {
    const now = this.clock.now();
    let opened = 0;
    for (const auctionId of await this.auctions.dueToOpen(now, limit)) {
      if (await this.open(auctionId, now)) {
        opened += 1;
      }
    }
    let closed = 0;
    let rescheduled = 0;
    for (const auctionId of await this.auctions.dueToClose(now, limit)) {
      const outcome = await this.close(auctionId, now);
      if (outcome === 'closed') {
        closed += 1;
      } else if (outcome === 'rescheduled') {
        rescheduled += 1;
      }
    }
    return { opened, closed, rescheduled };
  }

  private open(auctionId: string, now: Date): Promise<boolean> {
    return this.auctions.transaction(async (uow) => {
      const auction = await uow.lock(auctionId, { skipLocked: true });
      if (!auction || auction.status !== 'PROGRAMADA' || auction.startsAt.getTime() > now.getTime()) {
        return false;
      }
      await uow.update(auctionId, { status: 'ACTIVA' });
      await uow.emit([auctionStarted(auction)]);
      return true;
    });
  }

  private async close(auctionId: string, now: Date): Promise<'closed' | 'rescheduled' | 'skipped'> {
    const result = await this.auctions.transaction(async (uow) => {
      const auction = await uow.lock(auctionId, { skipLocked: true });
      if (!auction || auction.status !== 'ACTIVA' || auction.endsAt.getTime() > now.getTime()) {
        return null;
      }
      const winning = await uow.topActiveBid(auctionId);
      if (!winning) {
        // Sala vacia: la misma subasta se reprograma al precio de salida.
        const window = scheduleWindow(now, auction.durationMinutes, this.random);
        await uow.allowPriceRewind();
        await uow.deactivateBids(auctionId);
        await uow.update(auctionId, {
          status: 'PROGRAMADA',
          currentPrice: auction.startPrice,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          initialEndsAt: window.endsAt,
          resetExtensions: true,
          winnerId: null,
          winningBidId: null,
        });
        await uow.emit([auctionRescheduled(auctionId, auction.lotId)]);
        return { outcome: 'rescheduled' as const, auction, winnerId: null, amount: auction.startPrice };
      }
      await uow.update(auctionId, {
        status: 'CERRADA',
        winnerId: winning.bidderId,
        winningBidId: winning.id,
        currentPrice: winning.amount,
      });
      await uow.recordSale({
        auctionId,
        lotId: auction.lotId,
        buyerId: winning.bidderId,
        sellerId: auction.sellerId,
        amount: winning.amount,
        currency: auction.currency,
      });
      await uow.emit([
        auctionClosed({
          auctionId,
          lotId: auction.lotId,
          sellerId: auction.sellerId,
          winnerId: winning.bidderId,
          amount: winning.amount,
        }),
      ]);
      return { outcome: 'closed' as const, auction, winnerId: winning.bidderId, amount: winning.amount };
    });
    if (!result) {
      return 'skipped';
    }
    if (result.outcome === 'closed') {
      this.live.publish({
        kind: 'auction-closed',
        auctionId,
        lotId: result.auction.lotId,
        winnerId: result.winnerId,
        amount: result.amount,
      });
    }
    return result.outcome;
  }
}
