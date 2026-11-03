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

/** Compra inmediata: la salida por este factor, redondeada hacia arriba a multiplos de 50. */
export const DEFAULT_BUY_NOW_FACTOR = 3;
const BUY_NOW_STEP_COINS = 50;
/** La compra inmediata se ofrece mientras el precio actual no llegue a esta fraccion de su valor. */
export const BUY_NOW_AVAILABLE_RATIO = 0.8;

export function buyNowCoins(openingCoins: number, factor: number = DEFAULT_BUY_NOW_FACTOR): number {
  if (!Number.isFinite(factor) || factor <= 1) {
    throw new Error('El factor de compra inmediata debe ser mayor que 1');
  }
  const rounded = Math.ceil((openingCoins * factor) / BUY_NOW_STEP_COINS) * BUY_NOW_STEP_COINS;
  // Siempre por encima de la salida, aunque el factor sea bajo.
  return Math.max(rounded, (Math.floor(openingCoins / BUY_NOW_STEP_COINS) + 1) * BUY_NOW_STEP_COINS);
}

export type BuyNowRejection = 'NOT_ACTIVE' | 'CLOSED' | 'OWN_LOT' | 'UNAVAILABLE';

/** Sala abierta, sin vencer y con el precio por debajo del 80 % de la compra inmediata. */
export function buyNowOpen(input: { now: Date; status: AuctionStatus; endsAt: Date; currentPriceCents: number; buyNowCents: number }): boolean {
  return (
    input.status === 'ACTIVA' &&
    input.now.getTime() < input.endsAt.getTime() &&
    input.currentPriceCents < input.buyNowCents * BUY_NOW_AVAILABLE_RATIO
  );
}

export function evaluateBuyNow(input: {
  now: Date;
  status: AuctionStatus;
  sellerId: string;
  buyerId: string;
  endsAt: Date;
  currentPriceCents: number;
  buyNowCents: number;
}): { ok: true } | { ok: false; code: BuyNowRejection } {
  if (input.status !== 'ACTIVA') {
    return { ok: false, code: 'NOT_ACTIVE' };
  }
  if (input.now.getTime() >= input.endsAt.getTime()) {
    return { ok: false, code: 'CLOSED' };
  }
  if (input.buyerId === input.sellerId) {
    return { ok: false, code: 'OWN_LOT' };
  }
  return buyNowOpen(input) ? { ok: true } : { ok: false, code: 'UNAVAILABLE' };
}

export function buyNowRejectionError(code: BuyNowRejection): DomainError {
  switch (code) {
    case 'OWN_LOT':
      return DomainError.forbidden('No puedes comprar tu propia obra');
    case 'UNAVAILABLE':
      return DomainError.precondition('La compra inmediata ya no esta disponible: las pujas llegaron al 80 % de su precio.');
    case 'NOT_ACTIVE':
      return DomainError.precondition('La compra inmediata solo esta disponible con la sala abierta');
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

/**
 * Subastas rotativas del catalogo: salas cortas que abren a los pocos minutos
 * sobre obras publicadas sin subasta, para que siempre haya algo en vivo.
 */
export interface RotationPolicy {
  /** Salas que se mantienen en cartelera (activas o por abrir pronto). */
  slots: number;
  minMinutes: number;
  maxMinutes: number;
  /** Espera maxima entre crear la sala y abrirla. */
  maxLeadMs: number;
  /** Fraccion del precio sugerido por la auditoria que se usa como salida. */
  priceFactor: number;
  /** Factor de compra inmediata sobre la salida; sin el, DEFAULT_BUY_NOW_FACTOR. */
  buyNowFactor?: number;
}

/** La sala nunca abre en el mismo instante en que se crea: da tiempo a anunciarla. */
export const MIN_ROTATION_LEAD_MS = 60_000;

export function assertRotationPolicy(policy: RotationPolicy): RotationPolicy {
  if (!Number.isInteger(policy.slots) || policy.slots < 0) {
    throw new Error('AUTO_AUCTION_SLOTS debe ser un entero no negativo');
  }
  if (policy.minMinutes < 1 || policy.maxMinutes < policy.minMinutes) {
    throw new Error('La duracion minima de la rotacion debe ser positiva y no mayor que la maxima');
  }
  if (policy.maxLeadMs < MIN_ROTATION_LEAD_MS) {
    throw new Error('La espera maxima de la rotacion debe ser de al menos un minuto');
  }
  if (!(policy.priceFactor > 0 && policy.priceFactor <= 1)) {
    throw new Error('AUTO_AUCTION_PRICE_FACTOR debe estar entre 0 (excluido) y 1');
  }
  return policy;
}

/** Cuantas salas faltan para llenar la cartelera. */
export function rotationDeficit(liveCount: number, slots: number): number {
  return Math.max(0, slots - liveCount);
}

/** Salida de una sala rotativa: el punto medio de la auditoria escalado por el factor. */
export function rotationOpeningCoins(priceMin: number, priceMax: number, factor: number): number {
  const midpoint = (Math.max(0, priceMin) + Math.max(0, priceMax)) / 2;
  return Math.max(MIN_OPENING_COINS, Math.round(midpoint * factor));
}

/** Ventana de una sala rotativa: abre entre 1 minuto y la espera maxima, y dura entre el minimo y el maximo. */
export function rotationWindow(
  now: Date,
  policy: RotationPolicy,
  randomUnit: () => number = Math.random,
): { startsAt: Date; endsAt: Date; minutes: number } {
  const unit = () => Math.min(0.999999, Math.max(0, randomUnit()));
  const lead = MIN_ROTATION_LEAD_MS + Math.floor(unit() * (policy.maxLeadMs - MIN_ROTATION_LEAD_MS));
  const minutes = policy.minMinutes + Math.floor(unit() * (policy.maxMinutes - policy.minMinutes + 1));
  const startsAt = new Date(now.getTime() + lead);
  return { startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60_000), minutes };
}

/** Copia barajada (Fisher-Yates) con la fuente de azar dada, para poder fijarla en pruebas. */
export function shuffled<T>(items: readonly T[], randomUnit: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const unit = Math.min(0.999999, Math.max(0, randomUnit()));
    const other = Math.floor(unit * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}
