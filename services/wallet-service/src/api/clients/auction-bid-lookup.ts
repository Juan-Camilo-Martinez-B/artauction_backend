import type { auctionV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import type { BidLookup } from '../../internal/application/ports';

/**
 * Implementa el puerto BidLookup con AuctionService.GetBidByReservation. Si
 * auction no responde (o aun no existe), devuelve null y la reserva espera al
 * siguiente barrido en lugar de liberarse a ciegas.
 */
export class AuctionBidLookup implements BidLookup {
  constructor(
    private readonly auctions: auctionV1.AuctionServiceClient,
    private readonly tokens: ServiceTokenProvider,
    private readonly logger: StructuredLogger,
  ) {}

  async byReservation(reservationId: string): Promise<{ exists: boolean } | null> {
    try {
      const response = await invoke(this.auctions.getBidByReservation.bind(this.auctions), { reservationId }, {
        deadlineMs: 3_000,
        authorization: await this.tokens.authorization(),
      });
      return { exists: response.exists };
    } catch (error) {
      this.logger.warn(`no se pudo consultar la puja ${reservationId}: ${error instanceof Error ? error.message : String(error)}`, 'reservations');
      return null;
    }
  }
}
