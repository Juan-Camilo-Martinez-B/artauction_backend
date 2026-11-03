import type { DomainEvent } from '@artauction/platform';
import type { Auction, AuctionOrigin, Bid, CloseReason } from '../domain/auction';
import type { AuctionStatus } from '../domain/auction-rules';

export interface NewAuction {
  lotId: string;
  sellerId: string;
  lotTitle: string;
  startPrice: string;
  minIncrement: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  saleDescription: string | null;
  origin: AuctionOrigin;
  buyNowPrice: string;
}

export interface AuctionPatch {
  status?: AuctionStatus;
  startPrice?: string;
  minIncrement?: string;
  currentPrice?: string;
  durationMinutes?: number;
  origin?: AuctionOrigin;
  startsAt?: Date;
  endsAt?: Date;
  initialEndsAt?: Date;
  extensionCountIncrement?: boolean;
  resetExtensions?: boolean;
  winnerId?: string | null;
  winningBidId?: string | null;
  buyNowPrice?: string;
  closedBy?: CloseReason | null;
}

/**
 * Operaciones dentro de una transaccion sobre una subasta. La implementacion
 * bloquea la fila; las reglas las decide el caso de uso que la usa.
 */
export interface AuctionUnitOfWork {
  /** Bloquea la subasta (FOR UPDATE). Con `skipLocked`, devuelve null si otra instancia la tiene. */
  lock(auctionId: string, options?: { skipLocked?: boolean }): Promise<Auction | null>;
  /** Bloquea la subasta de una obra, si tiene. */
  lockByLot(lotId: string): Promise<Auction | null>;
  bidByKey(idempotencyKey: string): Promise<Bid | null>;
  activeBidCount(auctionId: string): Promise<number>;
  /** Postor que ya tiene activa una oferta por ese importe, si alguno. */
  activeBidderAt(auctionId: string, amount: string): Promise<string | null>;
  topActiveBid(auctionId: string): Promise<Bid | null>;
  bidderActiveBid(auctionId: string, bidderId: string): Promise<Bid | null>;
  insertBid(bid: { auctionId: string; bidderId: string; amount: string; idempotencyKey: string; buyNow?: boolean }): Promise<Bid>;
  /** Postores con una oferta activa en la sala. */
  activeBidderIds(auctionId: string): Promise<string[]>;
  deactivateBids(auctionId: string, bidderId?: string): Promise<void>;
  /** Permite bajar el precio actual en esta transaccion (retiro o reprogramacion). */
  allowPriceRewind(): Promise<void>;
  update(auctionId: string, patch: AuctionPatch): Promise<void>;
  recordSale(sale: { auctionId: string; lotId: string; buyerId: string; sellerId: string; amount: string; currency: string }): Promise<void>;
  /** Crea la subasta de la obra si todavia no tiene una; devuelve null si ya existia. */
  createIfAbsent(auction: NewAuction): Promise<Auction | null>;
  emit(events: DomainEvent[]): Promise<void>;
}

/**
 * Turno exclusivo de la rotacion: una sola instancia a la vez cuenta la
 * cartelera y crea salas, asi dos instancias no la llenan de mas.
 */
export interface RotationTurn {
  countLive(now: Date, horizonMs: number): Promise<number>;
  createIfAbsent(auction: NewAuction): Promise<Auction | null>;
  /**
   * Salas ROTATION programadas mas alla del horizonte (cerraron sin pujas y se
   * reprogramaron lejos), bloqueadas para adelantarlas. Salta las que otra
   * transaccion tiene.
   */
  recyclable(now: Date, horizonMs: number, limit: number): Promise<Auction[]>;
  update(auctionId: string, patch: AuctionPatch): Promise<void>;
}

export interface AuctionRepository {
  transaction<T>(work: (uow: AuctionUnitOfWork) => Promise<T>): Promise<T>;
  /** Aplica un evento entrante una sola vez (inbox) dentro de una transaccion. */
  applyOnce<T>(eventId: string, eventType: string, work: (uow: AuctionUnitOfWork) => Promise<T>): Promise<T | null>;
  findById(auctionId: string): Promise<Auction | null>;
  findByLotId(lotId: string): Promise<Auction | null>;
  findByLotIds(lotIds: readonly string[]): Promise<Auction[]>;
  recentBids(auctionId: string, limit: number): Promise<Bid[]>;
  bidByKey(idempotencyKey: string): Promise<Bid | null>;
  /** Crea la subasta y sus eventos; devuelve null si la obra ya tenia una. */
  create(auction: NewAuction, events: (auction: Auction) => DomainEvent[]): Promise<Auction | null>;
  dueToOpen(now: Date, limit: number): Promise<string[]>;
  dueToClose(now: Date, limit: number): Promise<string[]>;
  /** Cartelera: activas por cierre y luego programadas antes de `now + horizonMs` por apertura. */
  listLive(now: Date, horizonMs: number, limit: number): Promise<Auction[]>;
  /** Salas activas o programadas para abrir antes de `now + horizonMs`. */
  countLive(now: Date, horizonMs: number): Promise<number>;
  /** Ejecuta el turno de rotacion si ninguna otra instancia lo tiene; si no, devuelve null. */
  withRotationLock<T>(work: (turn: RotationTurn) => Promise<T>): Promise<T | null>;
}

/** Fase Try de TCC en wallet. Rechaza con DomainError si no hay saldo. */
export interface WalletPort {
  tryHold(input: { reservationId: string; auctionId: string; bidderId: string; nextCoins: number }): Promise<{ reservedCoins: number }>;
}

export interface LotSnapshot {
  lotId: string;
  sellerId: string;
  title: string;
  status: string;
}

/** Obra publicada con precio sugerido, candidata a una sala rotativa. */
export interface AuctionCandidate {
  lotId: string;
  sellerId: string;
  title: string;
  description: string;
  priceMin: number;
  priceMax: number;
}

export interface CatalogPort {
  lot(lotId: string): Promise<LotSnapshot | null>;
  /** Muestra al azar de obras publicadas; puede incluir obras que ya tienen sala. */
  auctionCandidates(limit: number): Promise<AuctionCandidate[]>;
}

export type LiveNotice =
  | {
      kind: 'bid-accepted';
      auctionId: string;
      bidId: string;
      bidderId: string;
      amount: string;
      endsAt: Date;
      extended: boolean;
    }
  | { kind: 'auction-closed'; auctionId: string; lotId: string; winnerId: string | null; amount: string; closedBy: CloseReason };

/** Avisos en vivo de una sala, publicados despues de confirmar la transaccion. */
export interface LiveFeed {
  publish(notice: LiveNotice): void;
}

export interface Clock {
  now(): Date;
}
