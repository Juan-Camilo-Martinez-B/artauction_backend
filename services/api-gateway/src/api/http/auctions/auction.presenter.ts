import { auctionV1 } from '@artauction/contracts';

// Forma JSON de las subastas que el frontend ya consume. Las pujas no exponen
// su clave de idempotencia: es un dato del pujador, no de la sala.

const AUCTION_STATUS: ReadonlyMap<auctionV1.AuctionStatus, string> = new Map([
  [auctionV1.AuctionStatus.AUCTION_STATUS_PROGRAMADA, 'PROGRAMADA'],
  [auctionV1.AuctionStatus.AUCTION_STATUS_ACTIVA, 'ACTIVA'],
  [auctionV1.AuctionStatus.AUCTION_STATUS_CERRADA, 'CERRADA'],
]);

export function auctionStatusName(status: auctionV1.AuctionStatus): string {
  return AUCTION_STATUS.get(status) ?? 'PROGRAMADA';
}

function iso(value: Date | undefined): string | null {
  return value?.toISOString() ?? null;
}

export function bidJson(bid: auctionV1.Bid) {
  return {
    id: bid.id,
    auctionId: bid.auctionId,
    bidderId: bid.bidderId,
    amount: bid.amount,
    active: bid.active,
    createdAt: iso(bid.createdAt),
  };
}

export function auctionDetailJson(auction: auctionV1.Auction) {
  return {
    id: auction.id,
    lotId: auction.lotId,
    sellerId: auction.sellerId,
    startPrice: auction.startPrice,
    currentPrice: auction.currentPrice,
    minIncrement: auction.minIncrement,
    currency: auction.currency,
    startsAt: iso(auction.startsAt),
    endsAt: iso(auction.endsAt),
    initialEndsAt: iso(auction.initialEndsAt),
    status: auctionStatusName(auction.status),
    winnerId: auction.winnerId ?? null,
    extensionCount: auction.extensionCount,
    durationMinutes: auction.durationMinutes,
    saleDescription: auction.saleDescription ?? null,
    bids: auction.bids.map(bidJson),
  };
}

export function placedBidJson(placed: auctionV1.PlaceBidResponse) {
  return {
    bidId: placed.bidId,
    auctionId: placed.auctionId,
    amount: placed.amount,
    endsAt: iso(placed.endsAt),
    extended: placed.extended,
    idempotent: placed.idempotent,
    currentPrice: placed.currentPrice,
  };
}
