import { createHash } from 'node:crypto';
import { DomainError } from '@artauction/platform';

/** Precio de una artacoin en centavos de dolar. */
export const COIN_PRICE_CENTS = 100;
export const MIN_TOP_UP_COINS = 50;
export const MAX_TOP_UP_COINS = 10_000;

/** Una reserva sin confirmar se revisa tras este tiempo. */
export const RESERVATION_TTL_MS = 2 * 60 * 1000;

export type EntryKind = 'RECARGA' | 'RETENCION' | 'LIBERACION' | 'CANJE' | 'VENTA';

export interface WalletEntry {
  id: string;
  kind: EntryKind;
  coins: number;
  createdAt: Date;
}

export interface WalletSnapshot {
  balance: number;
  held: number;
  entries: WalletEntry[];
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export function assertIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw DomainError.invalid('La clave de idempotencia debe tener entre 8 y 100 caracteres alfanumericos.');
  }
  return key;
}

export function assertTopUpCoins(coins: number): number {
  if (!Number.isInteger(coins) || coins < MIN_TOP_UP_COINS || coins > MAX_TOP_UP_COINS) {
    throw DomainError.invalid(`Se cargan entre ${String(MIN_TOP_UP_COINS)} y ${String(MAX_TOP_UP_COINS)} artacoins enteras.`);
  }
  return coins;
}

/**
 * Huella del contenido de una recarga. Detecta una clave de idempotencia
 * reutilizada con otros datos sin guardar el numero de tarjeta: solo entran la
 * cantidad, los ultimos cuatro digitos, la caducidad y el titular.
 */
export function topUpFingerprint(input: { coins: number; last4: string; expMonth: number; expYear: number; cardName: string }): string {
  return createHash('sha256')
    .update([input.coins, input.last4, input.expMonth, input.expYear, input.cardName.trim().toLowerCase()].join('|'))
    .digest('hex');
}

/** Cuanto mas hay que retener cuando la oferta de un postor sube de `previous` a `next`. */
export function holdIncrease(previous: number, next: number): number {
  if (!Number.isInteger(previous) || !Number.isInteger(next) || previous < 0 || next <= previous) {
    throw DomainError.invalid('La retencion solo crece en artacoins enteras.');
  }
  return next - previous;
}

/**
 * Retencion que queda al confirmar una reserva y artacoins que sobran.
 *
 * Cada reserva se calcula sobre la retencion confirmada en ese momento, no
 * sobre otras reservas pendientes: una pendiente puede ser de una puja que
 * auction rechazo despues del Try, y esa se libera por separado. Si otra
 * reserva se confirmo entre medias, la retencion ya cubre parte de esta y la
 * diferencia vuelve al saldo. Asi el saldo retirado siempre suma la mayor
 * oferta viva del postor.
 */
export function confirmHold(currentHold: number, reservation: { nextCoins: number; reservedCoins: number }): { hold: number; refund: number } {
  const hold = Math.max(currentHold, reservation.nextCoins);
  return { hold, refund: currentHold + reservation.reservedCoins - hold };
}

/** Una puja es un decimal en texto ("850.00"); en artacoins solo se admiten enteros. */
export function coinsFromAmount(amount: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match || (match[2] !== undefined && Number(match[2]) !== 0)) {
    throw DomainError.invalid(`Importe en artacoins no valido: ${amount}`);
  }
  return Number(match[1]);
}

/**
 * Reparte el precio de una venta: la plataforma cobra `feeBasisPoints`
 * (1000 = 10 %) redondeado hacia abajo y el vendedor recibe el resto.
 */
export function sellerPayout(grossCoins: number, feeBasisPoints: number): { feeCoins: number; netCoins: number } {
  if (!Number.isInteger(grossCoins) || grossCoins <= 0) {
    throw DomainError.invalid('El precio de venta debe ser positivo.');
  }
  if (!Number.isInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints > 10_000) {
    throw DomainError.invalid('La comision debe estar entre 0 y 10000 puntos basicos.');
  }
  const feeCoins = Math.floor((grossCoins * feeBasisPoints) / 10_000);
  return { feeCoins, netCoins: grossCoins - feeCoins };
}

export type ExpiredReservationDecision = 'CONFIRM' | 'RELEASE' | 'RETRY_LATER';

/**
 * Que hacer con una reserva vencida segun lo que diga auction: si la puja se
 * guardo, la retencion es legitima y se confirma; si no existe, se devuelve;
 * si auction no responde, se espera, porque liberar a ciegas podria quitar la
 * retencion de una puja valida.
 */
export function decideExpiredReservation(bid: { exists: boolean } | null): ExpiredReservationDecision {
  if (bid === null) {
    return 'RETRY_LATER';
  }
  return bid.exists ? 'CONFIRM' : 'RELEASE';
}
