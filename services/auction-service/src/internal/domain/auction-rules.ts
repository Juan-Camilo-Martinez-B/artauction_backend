import { DomainError } from '@artauction/platform';

// Reglas de la sala de subastas. TypeScript puro: el tiempo siempre llega como
// parametro, el reloj es el del servidor.

export type AuctionStatus = 'PROGRAMADA' | 'ACTIVA' | 'CERRADA';

/** Una puja en los ultimos 30 s extiende el cierre otros 30 s (antisniping). */
export const ANTI_SNIPE_MS = 30_000;
/** Nadie se retira en los ultimos 4 minutos: la sala no puede quedar vacia al cerrar. */
export const WITHDRAW_LEAD_MS = 4 * 60 * 1000;
export const MIN_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 180;
/** Una subasta programada abre entre 15 minutos y 48 horas despues. */
export const MIN_LEAD_MS = 15 * 60 * 1000;
export const MAX_LEAD_MS = 48 * 60 * 60 * 1000;
export const MIN_OPENING_COINS = 50;
export const MIN_INCREMENT_COINS = 10;

export type BidRejection = 'NOT_ACTIVE' | 'CLOSED' | 'OWN_LOT' | 'TOO_LOW';

export type BidDecision = { ok: true; nextEndsAt: Date; extended: boolean } | { ok: false; code: BidRejection };

export function evaluateBid(input: {
  now: Date;
  status: AuctionStatus;
  sellerId: string;
  bidderId: string;
  currentPriceCents: number;
  minIncrementCents: number;
  hasBids: boolean;
  endsAt: Date;
  amountCents: number;
}): BidDecision {
  if (input.status !== 'ACTIVA') {
    return { ok: false, code: 'NOT_ACTIVE' };
  }
  if (input.now.getTime() >= input.endsAt.getTime()) {
    return { ok: false, code: 'CLOSED' };
  }
  if (input.bidderId === input.sellerId) {
    return { ok: false, code: 'OWN_LOT' };
  }
  const minimum = input.hasBids ? input.currentPriceCents + input.minIncrementCents : input.currentPriceCents;
  if (input.amountCents < minimum) {
    return { ok: false, code: 'TOO_LOW' };
  }
  const remaining = input.endsAt.getTime() - input.now.getTime();
  const extended = remaining <= ANTI_SNIPE_MS;
  return { ok: true, extended, nextEndsAt: extended ? new Date(input.endsAt.getTime() + ANTI_SNIPE_MS) : input.endsAt };
}

export function rejectionError(code: BidRejection): DomainError {
  switch (code) {
    case 'OWN_LOT':
      return DomainError.forbidden('No puedes pujar por tu propia obra');
    case 'TOO_LOW':
      return DomainError.invalid('La puja no alcanza el incremento minimo');
    case 'NOT_ACTIVE':
      return DomainError.precondition('La subasta no esta activa');
    case 'CLOSED':
      return DomainError.precondition('La subasta ya cerro');
  }
}

export function canWithdraw(now: Date, endsAt: Date): boolean {
  return endsAt.getTime() - now.getTime() >= WITHDRAW_LEAD_MS;
}

/** Mas autenticidad, mas tiempo de sala: de 30 minutos (score 40) a 180 (score 100). */
export function durationMinutes(score: number): number {
  const clamped = Math.min(100, Math.max(40, Math.round(score)));
  return MIN_DURATION_MINUTES + Math.round(((clamped - 40) / 60) * (MAX_DURATION_MINUTES - MIN_DURATION_MINUTES));
}

export function openingCoins(priceMin: number, priceMax: number): number {
  return Math.max(MIN_OPENING_COINS, Math.round((Math.max(0, priceMin) + Math.max(0, priceMax)) / 2));
}

export function incrementCoins(opening: number): number {
  return Math.max(MIN_INCREMENT_COINS, Math.round(opening * 0.05));
}

export function saleDescription(title: string, rationale: string): string {
  const clean = rationale.trim().replace(/\s+/g, ' ');
  return (clean.length > 0 ? `${title}. ${clean}` : title).slice(0, 500);
}

export function clampDuration(minutes: number): number {
  return Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(minutes)));
}

/** Ventana de una subasta programada: abre al azar entre 15 min y 48 h. */
export function scheduleWindow(now: Date, duration: number, randomUnit: () => number = Math.random): { startsAt: Date; endsAt: Date } {
  const unit = Math.min(0.999999, Math.max(0, randomUnit()));
  const startsAt = new Date(now.getTime() + MIN_LEAD_MS + Math.floor(unit * (MAX_LEAD_MS - MIN_LEAD_MS)));
  return { startsAt, endsAt: new Date(startsAt.getTime() + clampDuration(duration) * 60_000) };
}
