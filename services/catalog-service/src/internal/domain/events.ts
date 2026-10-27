import type { DomainEvent } from '@artauction/platform';
import type { Lot } from './lot';

// Eventos de dominio que publica el catalogo. El payload es JSON plano; la capa
// api lo traduce a los mensajes de artauction.catalog.events.v1 al entregarlo.

export const CATALOG_EVENTS = {
  lotCreated: 'catalog.LotCreated',
  lotSubmitted: 'catalog.LotSubmitted',
  lotPublished: 'catalog.LotPublished',
} as const;

export function lotCreated(lot: Pick<Lot, 'id' | 'sellerId' | 'title' | 'artistName'>): DomainEvent {
  return {
    type: CATALOG_EVENTS.lotCreated,
    aggregateId: lot.id,
    payload: { lotId: lot.id, sellerId: lot.sellerId, title: lot.title, artistName: lot.artistName },
  };
}

export function lotSubmitted(lotId: string): DomainEvent {
  return { type: CATALOG_EVENTS.lotSubmitted, aggregateId: lotId, payload: { lotId } };
}

/** Aprobacion manual. Lleva lo que auction necesita para fijar los terminos de la venta. */
export function lotPublished(lot: Pick<Lot, 'id' | 'sellerId' | 'title' | 'authenticityScore' | 'suggestedPriceMin' | 'suggestedPriceMax'>): DomainEvent {
  return {
    type: CATALOG_EVENTS.lotPublished,
    aggregateId: lot.id,
    payload: {
      lotId: lot.id,
      sellerId: lot.sellerId,
      title: lot.title,
      score: lot.authenticityScore ?? 40,
      priceMin: Math.round(Number(lot.suggestedPriceMin ?? 50)),
      priceMax: Math.round(Number(lot.suggestedPriceMax ?? 50)),
    },
  };
}
