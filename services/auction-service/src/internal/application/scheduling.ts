import { DomainError } from '@artauction/platform';
import { auctionClosed, auctionRescheduled, auctionStarted, type Auction } from '../domain/auction';
import {
  buyNowCoins,
  clampDuration,
  DEFAULT_BUY_NOW_FACTOR,
  durationMinutes,
  incrementCoins,
  openingCoins,
  rotationDeficit,
  rotationOpeningCoins,
  rotationWindow,
  saleDescription,
  scheduleWindow,
  shuffled,
  type RotationPolicy,
} from '../domain/auction-rules';
import { assertWholeCoins, fromCents, toCents } from '../domain/money';
import type { AuctionCandidate, AuctionRepository, CatalogPort, Clock, LiveFeed, NewAuction } from './ports';

const SCHEDULABLE_LOT_STATUSES = new Set(['APROBADO', 'PUBLICADA']);

/** Precio de compra inmediata de una salida en artacoins, como decimal en texto. */
function buyNowPrice(openingCoinsValue: number, factor: number): string {
  return fromCents(buyNowCoins(openingCoinsValue, factor) * 100);
}

/** Apertura manual de un vendedor sobre una obra suya ya publicada. */
export class OpenAuction {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly catalog: CatalogPort,
    private readonly clock: Clock,
    private readonly buyNowFactor: number = DEFAULT_BUY_NOW_FACTOR,
  ) {}

  async execute(
    actor: { userId: string; role: string },
    input: { lotId: string; startPrice: string; minIncrement: string; startsAt: Date; endsAt: Date },
  ): Promise<Auction> {
    if (actor.role !== 'SELLER' && actor.role !== 'ADMIN') {
      throw DomainError.forbidden('Solo un vendedor abre subastas', { code: 'SELLER_ONLY' });
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
      throw DomainError.notFound('Obra no encontrada', { code: 'LOT_NOT_FOUND' });
    }
    if (!SCHEDULABLE_LOT_STATUSES.has(lot.status)) {
      throw DomainError.precondition('La obra no esta lista para subastarse', { code: 'LOT_NOT_READY_FOR_AUCTION' });
    }
    const terms = {
      startPrice: fromCents(startCents),
      minIncrement: fromCents(incrementCents),
      buyNowPrice: buyNowPrice(startCents / 100, this.buyNowFactor),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      durationMinutes: clampDuration((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000),
    };
    const opened = await this.auctions.transaction(async (uow) => {
      const existing = await uow.lockByLot(lot.lotId);
      if (!existing) {
        return uow.createIfAbsent({
          ...terms,
          lotId: lot.lotId,
          sellerId: lot.sellerId,
          lotTitle: lot.title,
          saleDescription: null,
          origin: 'MANUAL',
        });
      }
      if (existing.status !== 'PROGRAMADA') {
        return null;
      }
      // Una sala programada no tiene pujas activas: el vendedor la abre con sus
      // terminos y deja de ser del programador o de la rotacion.
      await uow.allowPriceRewind();
      await uow.update(existing.id, {
        ...terms,
        currentPrice: terms.startPrice,
        initialEndsAt: terms.endsAt,
        resetExtensions: true,
        origin: 'MANUAL',
      });
      return uow.lock(existing.id);
    });
    if (!opened) {
      throw DomainError.conflict('Esa obra ya tiene una subasta abierta o cerrada', { code: 'AUCTION_ALREADY_EXISTS' });
    }
    return opened;
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
    private readonly buyNowFactor: number = DEFAULT_BUY_NOW_FACTOR,
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
        buyNowPrice: buyNowPrice(opening, this.buyNowFactor),
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        durationMinutes: minutes,
        saleDescription: saleDescription(event.title, event.rationale),
        origin: 'SCHEDULED',
      }),
    );
  }
}

/** Tamano de la muestra que se pide a catalog, y de salas recicladas, en cada turno. */
const CANDIDATE_SAMPLE = 20;

/** Resultado de un turno de rotacion: salas nuevas y salas adelantadas. */
export interface RotationResult {
  created: number;
  recycled: number;
}

type RotationOption = { kind: 'fresh'; candidate: AuctionCandidate } | { kind: 'recycle'; auction: Auction };

/**
 * Mantiene la cartelera de subastas rotativas: si hay menos salas activas o por
 * abrir que `slots`, llena los huecos eligiendo al azar entre obras publicadas
 * sin subasta y salas ROTATION que cerraron sin pujas y quedaron programadas
 * lejos, que se adelantan. Asi la cartelera no se vacia cuando todas las obras
 * ya tienen sala. El dinero sigue el flujo normal: el vendedor de la obra cobra
 * la venta menos la comision. Es seguro con varias instancias (turno con
 * advisory lock y filas con SKIP LOCKED) y con reintentos (una obra tiene como
 * mucho una subasta).
 */
export class RotateCatalogAuctions {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly catalog: CatalogPort,
    private readonly clock: Clock,
    private readonly policy: RotationPolicy,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(): Promise<RotationResult> {
    const now = this.clock.now();
    const empty: RotationResult = { created: 0, recycled: 0 };
    // Sin hueco en la cartelera no se molesta a catalog.
    if (rotationDeficit(await this.auctions.countLive(now, this.policy.maxLeadMs), this.policy.slots) === 0) {
      return empty;
    }
    // Si catalog no responde, la cartelera se llena solo con salas recicladas.
    const fresh = await this.catalog.auctionCandidates(CANDIDATE_SAMPLE).catch((): AuctionCandidate[] => []);
    const result = await this.auctions.withRotationLock(async (turn) => {
      // Se vuelve a contar dentro del turno: otra instancia pudo crear salas entre tanto.
      let missing = rotationDeficit(await turn.countLive(now, this.policy.maxLeadMs), this.policy.slots);
      const done = { ...empty };
      if (missing === 0) {
        return done;
      }
      const recyclable = await turn.recyclable(now, this.policy.maxLeadMs, CANDIDATE_SAMPLE);
      const options = shuffled<RotationOption>(
        [
          ...fresh.map((candidate) => ({ kind: 'fresh' as const, candidate })),
          ...recyclable.map((auction) => ({ kind: 'recycle' as const, auction })),
        ],
        this.random,
      );
      for (const option of options) {
        if (missing === 0) {
          break;
        }
        const window = rotationWindow(now, this.policy, this.random);
        if (option.kind === 'recycle') {
          await turn.update(option.auction.id, {
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            initialEndsAt: window.endsAt,
            durationMinutes: window.minutes,
            resetExtensions: true,
          });
          done.recycled += 1;
          missing -= 1;
        } else if (await turn.createIfAbsent(this.terms(option.candidate, window))) {
          done.created += 1;
          missing -= 1;
        }
      }
      return done;
    });
    return result ?? empty;
  }

  private terms(candidate: AuctionCandidate, window: { startsAt: Date; endsAt: Date; minutes: number }): NewAuction {
    const opening = rotationOpeningCoins(candidate.priceMin, candidate.priceMax, this.policy.priceFactor);
    return {
      lotId: candidate.lotId,
      sellerId: candidate.sellerId,
      lotTitle: candidate.title,
      startPrice: fromCents(opening * 100),
      minIncrement: fromCents(incrementCoins(opening) * 100),
      buyNowPrice: buyNowPrice(opening, this.policy.buyNowFactor ?? DEFAULT_BUY_NOW_FACTOR),
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      durationMinutes: window.minutes,
      saleDescription: saleDescription(candidate.title, candidate.description),
      origin: 'ROTATION',
    };
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
      const losingBidderIds = (await uow.activeBidderIds(auctionId)).filter((bidderId) => bidderId !== winning.bidderId);
      await uow.update(auctionId, {
        status: 'CERRADA',
        closedBy: 'TIME',
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
          buyNow: false,
          losingBidderIds,
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
        closedBy: 'TIME',
      });
    }
    return result.outcome;
  }
}
