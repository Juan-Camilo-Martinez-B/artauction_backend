import type { DomainEvent } from '@artauction/platform';
import type { Auction, Bid } from '../domain/auction';
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
}

export interface AuctionPatch {
  status?: AuctionStatus;
  currentPrice?: string;
  startsAt?: Date;
  endsAt?: Date;
  initialEndsAt?: Date;
  extensionCountIncrement?: boolean;
  resetExtensions?: boolean;
  winnerId?: string | null;
  winningBidId?: string | null;
}

/**
 * Operaciones dentro de una transaccion sobre una subasta. La implementacion
 * bloquea la fila; las reglas las decide el caso de uso que la usa.
 */
export interface AuctionUnitOfWork {
  /** Bloquea la subasta (FOR UPDATE). Con `skipLocked`, devuelve null si otra instancia la tiene. */
  lock(auctionId: string, options?: { skipLocked?: boolean }): Promise<Auction | null>;
  bidByKey(idempotencyKey: string): Promise<Bid | null>;
  activeBidCount(auctionId: string): Promise<number>;
  /** Postor que ya tiene activa una oferta por ese importe, si alguno. */
  activeBidderAt(auctionId: string, amount: string): Promise<string | null>;
  topActiveBid(auctionId: string): Promise<Bid | null>;
  bidderActiveBid(auctionId: string, bidderId: string): Promise<Bid | null>;
  insertBid(bid: { auctionId: string; bidderId: string; amount: string; idempotencyKey: string }): Promise<Bid>;
  deactivateBids(auctionId: string, bidderId?: string): Promise<void>;
  /** Permite bajar el precio actual en esta transaccion (retiro o reprogramacion). */
  allowPriceRewind(): Promise<void>;
  update(auctionId: string, patch: AuctionPatch): Promise<void>;
  recordSale(sale: { auctionId: string; lotId: string; buyerId: string; sellerId: string; amount: string; currency: string }): Promise<void>;
  /** Crea la subasta de la obra si todavia no tiene una; devuelve null si ya existia. */
  createIfAbsent(auction: NewAuction): Promise<Auction | null>;
  emit(events: DomainEvent[]): Promise<void>;
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

export interface CatalogPort {
  lot(lotId: string): Promise<LotSnapshot | null>;
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
  | { kind: 'auction-closed'; auctionId: string; lotId: string; winnerId: string | null; amount: string };

/** Avisos en vivo de una sala, publicados despues de confirmar la transaccion. */
export interface LiveFeed {
  publish(notice: LiveNotice): void;
}

export interface Clock {
  now(): Date;
}
