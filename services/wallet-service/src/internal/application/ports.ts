import type { WalletSnapshot } from '../domain/wallet';

export interface TopUpRecord {
  orderId: string;
  userId: string;
  coins: number;
  approved: boolean;
  last4: string;
  requestHash: string | null;
}

export interface NewTopUp {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  coins: number;
  amountCents: number;
  approved: boolean;
  brand: string;
  last4: string;
}

/** Estado bloqueado (FOR UPDATE) de un postor en una subasta al reservar. */
export interface HoldState {
  balance: number;
  /** Retencion confirmada del postor en la subasta; las reservas pendientes no cuentan. */
  previousCoins: number;
  existing: { reservedCoins: number } | null;
}

export interface ReservationPlan {
  previousCoins: number;
  nextCoins: number;
  reservedCoins: number;
  expiresAt: Date;
}

export interface Reservation {
  reservationId: string;
  auctionId: string;
  bidderId: string;
  reservedCoins: number;
  expiresAt: Date;
}

export interface SaleSettlement {
  sellerId: string;
  grossCoins: number;
  feeCoins: number;
  netCoins: number;
}

/** Operaciones disponibles dentro de la transaccion de un evento entrante. */
export interface LedgerTransaction {
  confirmReservation(reservationId: string): Promise<boolean>;
  releaseReservation(reservationId: string): Promise<boolean>;
  releaseBidderHold(auctionId: string, bidderId: string): Promise<number>;
  /** Canjea la retencion del ganador, libera las demas y abona la venta. */
  settleAuction(auctionId: string, winnerId: string | null, sale: SaleSettlement | null): Promise<void>;
}

export interface WalletRepository {
  snapshot(userId: string, entryLimit: number): Promise<WalletSnapshot>;
  findTopUp(userId: string, idempotencyKey: string): Promise<TopUpRecord | null>;
  /**
   * Guarda la orden y, si se aprobo, abona el saldo en la misma transaccion.
   * Si otra peticion con la misma clave gano, devuelve esa orden con created=false.
   */
  recordTopUp(input: NewTopUp): Promise<{ record: TopUpRecord; created: boolean; balance: number }>;
  balance(userId: string): Promise<number>;
  /**
   * Bloquea el bolsillo del postor, entrega su estado a `plan` y aplica la
   * reserva que devuelva. Si la reserva ya existia, `plan` no se llama.
   */
  reserve(
    input: { reservationId: string; auctionId: string; bidderId: string },
    plan: (state: HoldState) => ReservationPlan,
  ): Promise<{ reservedCoins: number; balance: number }>;
  /** Aplica un evento entrante una sola vez (inbox) dentro de una transaccion. */
  applyOnce(eventId: string, eventType: string, work: (ledger: LedgerTransaction) => Promise<void>): Promise<boolean>;
  expiredReservations(now: Date, limit: number): Promise<Reservation[]>;
  /** Fuera de un evento: confirma o libera una reserva vencida. */
  resolveReservation(reservationId: string, decision: 'CONFIRM' | 'RELEASE'): Promise<boolean>;
}

export interface CardDetails {
  number: string;
  name: string;
  expMonth: number;
  expYear: number;
  cvv: string;
}

export interface ChargeResult {
  approved: boolean;
  brand: string;
  last4: string;
}

/**
 * Pasarela de pago. La clave de idempotencia viaja al proveedor, como en
 * Stripe, para que un reintento no cobre dos veces.
 */
export interface PaymentGateway {
  charge(input: { card: CardDetails; amountCents: number; idempotencyKey: string }): Promise<ChargeResult>;
}

/** Consulta a auction si una puja con esa reserva se guardo; null si no responde. */
export interface BidLookup {
  byReservation(reservationId: string): Promise<{ exists: boolean } | null>;
}

export interface Clock {
  now(): Date;
}
