import { DomainError } from '@artauction/platform';
import {
  assertIdempotencyKey,
  assertTopUpCoins,
  COIN_PRICE_CENTS,
  coinsFromAmount,
  decideExpiredReservation,
  holdIncrease,
  RESERVATION_TTL_MS,
  sellerPayout,
  topUpFingerprint,
  type WalletSnapshot,
} from '../domain/wallet';
import type { BidLookup, CardDetails, Clock, PaymentGateway, TopUpRecord, WalletRepository } from './ports';

const REJECTED = 'La pasarela rechazo la tarjeta.';
const KEY_REUSED = 'La clave de idempotencia ya se uso con otros datos.';

export class GetWallet {
  constructor(private readonly wallets: WalletRepository) {}

  execute(userId: string): Promise<WalletSnapshot> {
    return this.wallets.snapshot(userId, 20);
  }
}

export interface TopUpResult {
  balance: number;
  credited: number;
  last4: string;
  orderId: string;
}

/**
 * Recarga idempotente. Misma clave y mismo contenido devuelven la orden ya
 * creada sin cobrar otra vez; misma clave con otro contenido es un conflicto.
 * La orden y el abono se guardan en una sola transaccion.
 */
export class TopUp {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly gateway: PaymentGateway,
  ) {}

  async execute(userId: string, input: { idempotencyKey: string; coins: number; card: CardDetails }): Promise<TopUpResult> {
    const key = assertIdempotencyKey(input.idempotencyKey);
    const coins = assertTopUpCoins(input.coins);
    const last4 = input.card.number.replace(/\s+/g, '').slice(-4);
    const fingerprint = topUpFingerprint({
      coins,
      last4,
      expMonth: input.card.expMonth,
      expYear: input.card.expYear,
      cardName: input.card.name,
    });

    const previous = await this.wallets.findTopUp(userId, key);
    if (previous) {
      return this.replay(previous, fingerprint);
    }
    const amountCents = coins * COIN_PRICE_CENTS;
    const charge = await this.gateway.charge({ card: input.card, amountCents, idempotencyKey: key });
    const { record, created, balance } = await this.wallets.recordTopUp({
      userId,
      idempotencyKey: key,
      requestHash: fingerprint,
      coins,
      amountCents,
      approved: charge.approved,
      brand: charge.brand,
      last4: charge.last4,
    });
    if (!created) {
      return this.replay(record, fingerprint);
    }
    if (!record.approved) {
      throw DomainError.invalid(REJECTED);
    }
    return { balance, credited: record.coins, last4: record.last4, orderId: record.orderId };
  }

  private async replay(record: TopUpRecord, fingerprint: string): Promise<TopUpResult> {
    if (record.requestHash !== fingerprint) {
      throw DomainError.conflict(KEY_REUSED);
    }
    if (!record.approved) {
      throw DomainError.invalid(REJECTED);
    }
    return {
      balance: await this.wallets.balance(record.userId),
      credited: record.coins,
      last4: record.last4,
      orderId: record.orderId,
    };
  }
}

/**
 * Fase Try de TCC. Reserva solo la diferencia entre lo ya retenido y la nueva
 * oferta. Idempotente por reservationId (la clave de idempotencia de la puja).
 */
export class TryHold {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly clock: Clock,
  ) {}

  execute(input: { reservationId: string; auctionId: string; bidderId: string; nextCoins: number }) {
    return this.wallets.reserve(input, (state) => {
      const reservedCoins = holdIncrease(state.previousCoins, input.nextCoins);
      if (state.balance < reservedCoins) {
        throw DomainError.precondition(
          `No tienes artacoins suficientes. Faltan ${String(reservedCoins - state.balance)} en el bolsillo.`,
        );
      }
      return {
        previousCoins: state.previousCoins,
        nextCoins: input.nextCoins,
        reservedCoins,
        expiresAt: new Date(this.clock.now().getTime() + RESERVATION_TTL_MS),
      };
    });
  }
}

export interface IncomingEvent {
  eventId: string;
}

/** Fase Confirm: la puja se guardo y su reserva pasa a ser retencion. */
export class ConfirmBidHold {
  constructor(private readonly wallets: WalletRepository) {}

  execute(event: IncomingEvent & { reservationId: string }): Promise<boolean> {
    return this.wallets.applyOnce(event.eventId, 'auction.BidAccepted', async (ledger) => {
      await ledger.confirmReservation(event.reservationId);
    });
  }
}

/** El postor se retiro: se le devuelve toda su retencion en esa subasta. */
export class ReleaseBidderHold {
  constructor(private readonly wallets: WalletRepository) {}

  execute(event: IncomingEvent & { auctionId: string; bidderId: string }): Promise<boolean> {
    return this.wallets.applyOnce(event.eventId, 'auction.BidWithdrawn', async (ledger) => {
      await ledger.releaseBidderHold(event.auctionId, event.bidderId);
    });
  }
}

/**
 * Cierre con ganador: canjea su retencion, libera la de los demas y abona al
 * vendedor el precio menos la comision.
 */
export class SettleClosedAuction {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly feeBasisPoints: number,
  ) {}

  execute(event: IncomingEvent & { auctionId: string; winnerId: string | null; sellerId: string; amount: string }): Promise<boolean> {
    let sale = null;
    if (event.winnerId !== null) {
      const grossCoins = coinsFromAmount(event.amount);
      sale = { sellerId: event.sellerId, grossCoins, ...sellerPayout(grossCoins, this.feeBasisPoints) };
    }
    return this.wallets.applyOnce(event.eventId, 'auction.AuctionClosed', async (ledger) => {
      await ledger.settleAuction(event.auctionId, event.winnerId, sale);
    });
  }
}

/** Subasta reprogramada sin pujas: todas las retenciones vuelven a sus postores. */
export class ReleaseAuctionHolds {
  constructor(private readonly wallets: WalletRepository) {}

  execute(event: IncomingEvent & { auctionId: string }): Promise<boolean> {
    return this.wallets.applyOnce(event.eventId, 'auction.AuctionRescheduled', async (ledger) => {
      await ledger.settleAuction(event.auctionId, null, null);
    });
  }
}

/**
 * Barrido de reservas vencidas: antes de liberar pregunta a auction si la puja
 * existe. Devuelve cuantas reservas resolvio.
 */
export class SweepExpiredReservations {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly bids: BidLookup,
    private readonly clock: Clock,
  ) {}

  async execute(limit = 50): Promise<number> {
    let resolved = 0;
    for (const reservation of await this.wallets.expiredReservations(this.clock.now(), limit)) {
      const decision = decideExpiredReservation(await this.bids.byReservation(reservation.reservationId));
      if (decision !== 'RETRY_LATER' && (await this.wallets.resolveReservation(reservation.reservationId, decision))) {
        resolved += 1;
      }
    }
    return resolved;
  }
}
