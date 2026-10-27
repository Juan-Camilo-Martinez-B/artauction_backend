import type { LotRepository } from './ports';

// Reacciones del catalogo a eventos de otros servicios. Cada una se aplica una
// sola vez por event id (inbox) y solo si el lote esta en el estado esperado:
// un evento tardio o repetido no puede retroceder el ciclo de vida.

export interface IncomingEvent {
  eventId: string;
}

export class ApplyAuditVerdict {
  constructor(private readonly lots: LotRepository) {}

  execute(event: IncomingEvent & { lotId: string; approved: boolean; score: number; priceMin: number; priceMax: number }): Promise<boolean> {
    return this.lots.applyOnce(event.eventId, 'audit.AuditCompleted', async (lots) => {
      await lots.update(event.lotId, ['PENDIENTE_AUDITORIA'], event.approved ? 'PUBLICADA' : 'REVISION_MANUAL', {
        visibility: event.approved ? 'PUBLIC' : 'PRIVATE',
        authenticityScore: event.score,
        suggestedPriceMin: event.priceMin.toFixed(2),
        suggestedPriceMax: event.priceMax.toFixed(2),
      });
    });
  }
}

export class MarkLotInAuction {
  constructor(private readonly lots: LotRepository) {}

  execute(event: IncomingEvent & { lotId: string }): Promise<boolean> {
    return this.lots.applyOnce(event.eventId, 'auction.AuctionStarted', async (lots) => {
      await lots.update(event.lotId, ['APROBADO', 'PUBLICADA'], 'EN_SUBASTA', {});
    });
  }
}

export class MarkLotSold {
  constructor(private readonly lots: LotRepository) {}

  execute(event: IncomingEvent & { lotId: string }): Promise<boolean> {
    return this.lots.applyOnce(event.eventId, 'auction.AuctionClosed', async (lots) => {
      await lots.update(event.lotId, ['EN_SUBASTA'], 'VENDIDA', { visibility: 'PRIVATE' });
    });
  }
}

export class RepublishUnsoldLot {
  constructor(private readonly lots: LotRepository) {}

  execute(event: IncomingEvent & { lotId: string }): Promise<boolean> {
    return this.lots.applyOnce(event.eventId, 'auction.AuctionRescheduled', async (lots) => {
      await lots.update(event.lotId, ['EN_SUBASTA'], 'PUBLICADA', { visibility: 'PUBLIC' });
    });
  }
}
