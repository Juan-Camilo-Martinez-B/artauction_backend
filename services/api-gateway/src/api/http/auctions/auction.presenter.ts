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

/** Por que cerro la sala: TIME, BUY_NOW o null si sigue abierta. */
export function closeReasonName(reason: auctionV1.CloseReason): 'TIME' | 'BUY_NOW' | null {
  switch (reason) {
    case auctionV1.CloseReason.CLOSE_REASON_TIME:
      return 'TIME';
    case auctionV1.CloseReason.CLOSE_REASON_BUY_NOW:
      return 'BUY_NOW';
    default:
      return null;
  }
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
    buyNow: bid.buyNow,
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
    buyNowPrice: auction.buyNowPrice,
    buyNowAvailable: auction.buyNowAvailable,
    closedBy: closeReasonName(auction.closedBy),
  };
}

export function boughtNowJson(bought: auctionV1.BuyNowResponse) {
  return { auctionId: bought.auctionId, bidId: bought.bidId, amount: bought.amount, idempotent: bought.idempotent };
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
