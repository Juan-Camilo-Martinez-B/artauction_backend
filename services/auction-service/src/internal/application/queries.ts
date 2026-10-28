import { DomainError } from '@artauction/platform';
import type { Auction, Bid } from '../domain/auction';
import type { AuctionRepository } from './ports';

const MAX_BATCH = 100;

export class GetAuction {
  constructor(private readonly auctions: AuctionRepository) {}

  async execute(auctionId: string): Promise<{ auction: Auction; bids: Bid[] }> {
    const auction = await this.auctions.findById(auctionId);
    if (!auction) {
      throw DomainError.notFound('Subasta no encontrada');
    }
    return { auction, bids: await this.auctions.recentBids(auctionId, 20) };
  }
}

/** Resumen de subasta por obra, para que el gateway componga las fichas del catalogo. */
export class BatchGetAuctionSummaries {
  constructor(private readonly auctions: AuctionRepository) {}

  execute(lotIds: readonly string[]): Promise<Auction[]> {
    const unique = [...new Set(lotIds)];
    if (unique.length > MAX_BATCH) {
      throw DomainError.invalid(`Se piden como maximo ${String(MAX_BATCH)} obras por llamada.`);
    }
    return this.auctions.findByLotIds(unique);
  }
}

/** Para el barrido de reservas de wallet: dice si una puja con esa clave se guardo. */
export class GetBidByReservation {
  constructor(private readonly auctions: AuctionRepository) {}

  async execute(reservationId: string): Promise<{ exists: boolean; active: boolean }> {
    const bid = await this.auctions.bidByKey(reservationId);
    return { exists: bid !== null, active: bid?.active ?? false };
  }
}
