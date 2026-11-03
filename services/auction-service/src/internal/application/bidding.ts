import { DomainError, KeyedSerialQueue } from '@artauction/platform';
import { auctionClosed, bidAccepted, bidWithdrawn, type Auction } from '../domain/auction';
import { buyNowRejectionError, canWithdraw, evaluateBid, evaluateBuyNow, rejectionError } from '../domain/auction-rules';
import { assertWholeCoins, fromCents, publishedAmount, toCents } from '../domain/money';
import type { AuctionRepository, AuctionUnitOfWork, Clock, LiveFeed, WalletPort } from './ports';

export interface PlacedBid {
  bidId: string;
  auctionId: string;
  amount: string;
  endsAt: Date;
  extended: boolean;
  idempotent: boolean;
  currentPrice: string;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Pujar con retencion TCC:
 *   1. Valida contra el estado actual (falla rapido, sin tocar el bolsillo).
 *   2. Try: reserva la diferencia en wallet sin ningun bloqueo de base abierto.
 *   3. Bloquea la subasta, revalida con el estado fresco y guarda la puja con
 *      su evento BidAccepted (que confirma la reserva) en una sola transaccion.
 * Si el paso 3 falla, la reserva queda sin puja y el barrido de wallet la
 * devuelve tras preguntar a auction. Las pujas de una misma sala van en serie.
 */
export class PlaceBid {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly wallet: WalletPort,
    private readonly live: LiveFeed,
    private readonly clock: Clock,
    private readonly lane: KeyedSerialQueue = new KeyedSerialQueue(),
  ) {}

  execute(bidderId: string, input: { auctionId: string; amount: string; idempotencyKey: string }): Promise<PlacedBid> {
    return this.lane.run(input.auctionId, () => this.place(bidderId, input));
  }

  private async place(bidderId: string, input: { auctionId: string; amount: string; idempotencyKey: string }): Promise<PlacedBid> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw DomainError.invalid('La clave de idempotencia de la puja no es valida.');
    }
    const amountCents = toCents(input.amount);
    const coins = assertWholeCoins(amountCents);
    const amount = fromCents(amountCents);

    const repeated = await this.auctions.bidByKey(input.idempotencyKey);
    if (repeated) {
      return this.replay(repeated, bidderId, input.auctionId, amountCents);
    }
    const snapshot = await this.auctions.findById(input.auctionId);
    if (!snapshot) {
      throw DomainError.notFound('Subasta no encontrada');
    }
    // Prevalidacion laxa (como si no hubiera pujas): solo evita reservar en
    // wallet una puja que de seguro no vale. La estricta va dentro del lock.
    this.assertAcceptable(snapshot, bidderId, amountCents, false);

    await this.wallet.tryHold({ reservationId: input.idempotencyKey, auctionId: input.auctionId, bidderId, nextCoins: coins });

    const placed = await this.auctions.transaction(async (uow) => {
      const auction = await uow.lock(input.auctionId);
      if (!auction) {
        throw DomainError.notFound('Subasta no encontrada');
      }
      const raced = await uow.bidByKey(input.idempotencyKey);
      if (raced) {
        return { ...(await this.replay(raced, bidderId, input.auctionId, amountCents)), fresh: false };
      }
      const decision = this.assertAcceptable(auction, bidderId, amountCents, (await uow.activeBidCount(auction.id)) > 0);
      await this.assertAmountFree(uow, auction.id, amount, bidderId, amountCents);
      await uow.deactivateBids(auction.id, bidderId);
      const bid = await uow.insertBid({ auctionId: auction.id, bidderId, amount, idempotencyKey: input.idempotencyKey });
      await uow.update(auction.id, {
        currentPrice: amount,
        endsAt: decision.nextEndsAt,
        extensionCountIncrement: decision.extended,
      });
      await uow.emit([
        bidAccepted({
          auctionId: auction.id,
          bidId: bid.id,
          bidderId,
          amount,
          endsAt: decision.nextEndsAt,
          extended: decision.extended,
          reservationId: input.idempotencyKey,
          heldCoins: coins,
        }),
      ]);
      const result: PlacedBid = {
        bidId: bid.id,
        auctionId: auction.id,
        amount,
        endsAt: decision.nextEndsAt,
        extended: decision.extended,
        idempotent: false,
        currentPrice: amount,
      };
      return { ...result, fresh: true };
    });

    const { fresh, ...result } = placed;
    if (fresh) {
      this.live.publish({
        kind: 'bid-accepted',
        auctionId: result.auctionId,
        bidId: result.bidId,
        bidderId,
        amount: result.amount,
        endsAt: result.endsAt,
        extended: result.extended,
      });
    }
    return result;
  }

  /** Con `hasBids` del estado leido; lanza el error de dominio si la puja no vale. */
  private assertAcceptable(auction: Auction, bidderId: string, amountCents: number, hasBids: boolean) {
    const decision = evaluateBid({
      now: this.clock.now(),
      status: auction.status,
      sellerId: auction.sellerId,
      bidderId,
      currentPriceCents: toCents(auction.currentPrice),
      minIncrementCents: toCents(auction.minIncrement),
      hasBids,
      endsAt: auction.endsAt,
      amountCents,
    });
    if (!decision.ok) {
      throw rejectionError(decision.code);
    }
    return decision;
  }

  /** Dos postores no pueden publicar el mismo importe en la misma sala. */
  private async assertAmountFree(uow: AuctionUnitOfWork, auctionId: string, amount: string, bidderId: string, amountCents: number) {
    const owner = await uow.activeBidderAt(auctionId, amount);
    if (owner && owner !== bidderId) {
      throw DomainError.conflict(`La oferta de ${publishedAmount(amountCents)} ya fue publicada por otro usuario.`);
    }
    if (owner === bidderId) {
      throw DomainError.conflict(`Ya publicaste la oferta de ${publishedAmount(amountCents)}.`);
    }
  }

  /** Misma clave: misma puja si coinciden postor, sala e importe; si no, conflicto. */
  private async replay(
    bid: { id: string; auctionId: string; bidderId: string; amount: string },
    bidderId: string,
    auctionId: string,
    amountCents: number,
  ): Promise<PlacedBid> {
    if (bid.bidderId !== bidderId || bid.auctionId !== auctionId || toCents(bid.amount) !== amountCents) {
      throw DomainError.conflict('idempotencyKey reutilizada');
    }
    const auction = await this.auctions.findById(auctionId);
    if (!auction) {
      throw DomainError.notFound('Subasta no encontrada');
    }
    return {
      bidId: bid.id,
      auctionId,
      amount: fromCents(amountCents),
      endsAt: auction.endsAt,
      extended: false,
      idempotent: true,
      currentPrice: auction.currentPrice,
    };
  }
}

export interface BoughtNow {
  auctionId: string;
  bidId: string;
  amount: string;
  idempotent: boolean;
}

/**
 * Compra inmediata. Sigue los pasos de una puja, con la misma retencion TCC y
 * la misma clave de idempotencia, pero su puja (kind BUY_NOW) gana la sala y la
 * cierra en la misma transaccion: el outbox entrega primero BidAccepted (wallet
 * confirma la reserva) y luego AuctionClosed (wallet cobra, libera a los demas
 * y paga al vendedor). Si dos personas compran a la vez, gana la que bloquea la
 * sala primero; la reserva de la otra la devuelve el barrido de wallet.
 */
export class BuyNow {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly wallet: WalletPort,
    private readonly live: LiveFeed,
    private readonly clock: Clock,
    private readonly lane: KeyedSerialQueue = new KeyedSerialQueue(),
  ) {}

  execute(buyerId: string, input: { auctionId: string; idempotencyKey: string }): Promise<BoughtNow> {
    return this.lane.run(input.auctionId, () => this.buy(buyerId, input));
  }

  private async buy(buyerId: string, input: { auctionId: string; idempotencyKey: string }): Promise<BoughtNow> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw DomainError.invalid('La clave de idempotencia de la compra no es valida.');
    }
    const repeated = await this.auctions.bidByKey(input.idempotencyKey);
    if (repeated) {
      return this.replay(repeated, buyerId, input.auctionId);
    }
    const snapshot = await this.auctions.findById(input.auctionId);
    if (!snapshot) {
      throw DomainError.notFound('Subasta no encontrada');
    }
    this.assertAvailable(snapshot, buyerId);
    const price = snapshot.buyNowPrice;
    const coins = assertWholeCoins(toCents(price));

    await this.wallet.tryHold({ reservationId: input.idempotencyKey, auctionId: input.auctionId, bidderId: buyerId, nextCoins: coins });

    const bought = await this.auctions.transaction(async (uow) => {
      const auction = await uow.lock(input.auctionId);
      if (!auction) {
        throw DomainError.notFound('Subasta no encontrada');
      }
      const raced = await uow.bidByKey(input.idempotencyKey);
      if (raced) {
        return { ...this.replay(raced, buyerId, input.auctionId), lotId: auction.lotId, fresh: false };
      }
      // Con el estado fresco: otra compra o una puja alta pudo ganar la carrera.
      this.assertAvailable(auction, buyerId);
      await uow.deactivateBids(auction.id, buyerId);
      const bid = await uow.insertBid({ auctionId: auction.id, bidderId: buyerId, amount: auction.buyNowPrice, idempotencyKey: input.idempotencyKey, buyNow: true });
      const losingBidderIds = (await uow.activeBidderIds(auction.id)).filter((bidderId) => bidderId !== buyerId);
      await uow.update(auction.id, {
        status: 'CERRADA',
        closedBy: 'BUY_NOW',
        currentPrice: auction.buyNowPrice,
        winnerId: buyerId,
        winningBidId: bid.id,
      });
      await uow.recordSale({
        auctionId: auction.id,
        lotId: auction.lotId,
        buyerId,
        sellerId: auction.sellerId,
        amount: auction.buyNowPrice,
        currency: auction.currency,
      });
      await uow.emit([
        bidAccepted({
          auctionId: auction.id,
          bidId: bid.id,
          bidderId: buyerId,
          amount: auction.buyNowPrice,
          endsAt: auction.endsAt,
          extended: false,
          reservationId: input.idempotencyKey,
          heldCoins: coins,
        }),
        auctionClosed({
          auctionId: auction.id,
          lotId: auction.lotId,
          sellerId: auction.sellerId,
          winnerId: buyerId,
          amount: auction.buyNowPrice,
          buyNow: true,
          losingBidderIds,
        }),
      ]);
      const result: BoughtNow = { auctionId: auction.id, bidId: bid.id, amount: auction.buyNowPrice, idempotent: false };
      return { ...result, lotId: auction.lotId, fresh: true };
    });

    const { fresh, lotId, ...result } = bought;
    if (fresh) {
      this.live.publish({ kind: 'auction-closed', auctionId: result.auctionId, lotId, winnerId: buyerId, amount: result.amount, closedBy: 'BUY_NOW' });
    }
    return result;
  }

  private assertAvailable(auction: Auction, buyerId: string): void {
    const decision = evaluateBuyNow({
      now: this.clock.now(),
      status: auction.status,
      sellerId: auction.sellerId,
      buyerId,
      endsAt: auction.endsAt,
      currentPriceCents: toCents(auction.currentPrice),
      buyNowCents: toCents(auction.buyNowPrice),
    });
    if (!decision.ok) {
      throw buyNowRejectionError(decision.code);
    }
  }

  /** Misma clave: la misma compra si es del mismo comprador y sala; si no, conflicto. */
  private replay(bid: { id: string; auctionId: string; bidderId: string; amount: string; buyNow: boolean }, buyerId: string, auctionId: string): BoughtNow {
    if (!bid.buyNow || bid.bidderId !== buyerId || bid.auctionId !== auctionId) {
      throw DomainError.conflict('idempotencyKey reutilizada');
    }
    return { auctionId, bidId: bid.id, amount: bid.amount, idempotent: true };
  }
}

/**
 * El postor se retira: sus ofertas dejan de contar, el precio vuelve a la mejor
 * oferta restante y wallet le devuelve la retencion al recibir BidWithdrawn.
 */
export class WithdrawBid {
  constructor(
    private readonly auctions: AuctionRepository,
    private readonly clock: Clock,
    private readonly lane: KeyedSerialQueue = new KeyedSerialQueue(),
  ) {}

  execute(bidderId: string, auctionId: string): Promise<{ auctionId: string; released: number; currentPrice: string }> {
    return this.lane.run(auctionId, () =>
      this.auctions.transaction(async (uow) => {
        const auction = await uow.lock(auctionId);
        if (!auction) {
          throw DomainError.notFound('Subasta no encontrada');
        }
        if (auction.status !== 'ACTIVA') {
          throw DomainError.precondition('La subasta no esta activa');
        }
        if (!canWithdraw(this.clock.now(), auction.endsAt)) {
          throw DomainError.precondition('No puedes retirarte durante los ultimos 4 minutos de la subasta.');
        }
        const mine = await uow.bidderActiveBid(auctionId, bidderId);
        if (!mine) {
          throw DomainError.invalid('No tienes una oferta activa en esta sala.');
        }
        const leading = toCents(mine.amount) >= toCents(auction.currentPrice);
        await uow.allowPriceRewind();
        await uow.deactivateBids(auctionId, bidderId);
        let currentPrice = auction.currentPrice;
        if (leading) {
          const next = await uow.topActiveBid(auctionId);
          currentPrice = next ? next.amount : auction.startPrice;
          await uow.update(auctionId, { currentPrice });
        }
        await uow.emit([bidWithdrawn(auctionId, bidderId)]);
        return { auctionId, released: toCents(mine.amount) / 100, currentPrice };
      }),
    );
  }
}
