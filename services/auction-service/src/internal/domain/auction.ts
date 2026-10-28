import type { DomainEvent } from '@artauction/platform';
import type { AuctionStatus } from './auction-rules';

export interface Bid {
  id: string;
  auctionId: string;
  bidderId: string;
  /** Decimal en texto ("850.00"). */
  amount: string;
  active: boolean;
  createdAt: Date;
}

export interface Auction {
  id: string;
  lotId: string;
  sellerId: string;
  lotTitle: string;
  startPrice: string;
  currentPrice: string;
  minIncrement: string;
  currency: string;
  startsAt: Date;
  endsAt: Date;
  initialEndsAt: Date;
  status: AuctionStatus;
  winnerId: string | null;
  extensionCount: number;
  durationMinutes: number;
  saleDescription: string | null;
}

export const AUCTION_EVENTS = {
  started: 'auction.AuctionStarted',
  bidAccepted: 'auction.BidAccepted',
  bidWithdrawn: 'auction.BidWithdrawn',
  closed: 'auction.AuctionClosed',
  rescheduled: 'auction.AuctionRescheduled',
} as const;

// El agregado de todos los eventos es la subasta: el outbox los entrega en
// orden por subasta (una confirmacion de puja nunca llega despues del cierre).

export function auctionStarted(auction: Pick<Auction, 'id' | 'lotId'>): DomainEvent {
  return { type: AUCTION_EVENTS.started, aggregateId: auction.id, payload: { auctionId: auction.id, lotId: auction.lotId } };
}

export function bidAccepted(input: {
  auctionId: string;
  bidId: string;
  bidderId: string;
  amount: string;
  endsAt: Date;
  extended: boolean;
  reservationId: string;
  heldCoins: number;
}): DomainEvent {
  return {
    type: AUCTION_EVENTS.bidAccepted,
    aggregateId: input.auctionId,
    payload: { ...input, endsAt: input.endsAt.toISOString() },
  };
}

export function bidWithdrawn(auctionId: string, bidderId: string): DomainEvent {
  return { type: AUCTION_EVENTS.bidWithdrawn, aggregateId: auctionId, payload: { auctionId, bidderId } };
}

export function auctionClosed(input: { auctionId: string; lotId: string; sellerId: string; winnerId: string; amount: string }): DomainEvent {
  return { type: AUCTION_EVENTS.closed, aggregateId: input.auctionId, payload: { ...input } };
}

export function auctionRescheduled(auctionId: string, lotId: string): DomainEvent {
  return { type: AUCTION_EVENTS.rescheduled, aggregateId: auctionId, payload: { auctionId, lotId } };
}
