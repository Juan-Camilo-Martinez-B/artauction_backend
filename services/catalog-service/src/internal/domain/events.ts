import type { DomainEvent } from '@artauction/platform';
import type { Lot } from './lot';

// Eventos de dominio que publica el catalogo. El payload es JSON plano; la capa
// api lo traduce a los mensajes de artauction.catalog.events.v1 al entregarlo.

export const CATALOG_EVENTS = {
  lotCreated: 'catalog.LotCreated',
  lotSubmitted: 'catalog.LotSubmitted',
  lotListed: 'catalog.LotListed',
  lotPublished: 'catalog.LotPublished',
  lotReturnedToDraft: 'catalog.LotReturnedToDraft',
  lotVisibilityChanged: 'catalog.LotVisibilityChanged',
} as const;

/** La obra entra en la galeria de su autor; un proyecto propio llega con su visibilidad. */
export function lotCreated(lot: Pick<Lot, 'id' | 'sellerId' | 'title' | 'artistName' | 'status' | 'visibility'>): DomainEvent {
  return {
    type: CATALOG_EVENTS.lotCreated,
    aggregateId: lot.id,
    payload: {
      lotId: lot.id,
      sellerId: lot.sellerId,
      title: lot.title,
      artistName: lot.artistName,
      personal: lot.status === 'PERSONAL',
      visibility: lot.visibility,
    },
  };
}

/** El autor mostro u oculto un proyecto propio en su galeria publica. */
export function lotVisibilityChanged(lot: Pick<Lot, 'id' | 'sellerId' | 'visibility'>): DomainEvent {
  return {
    type: CATALOG_EVENTS.lotVisibilityChanged,
    aggregateId: lot.id,
    payload: { lotId: lot.id, ownerId: lot.sellerId, visibility: lot.visibility },
  };
}

export function lotSubmitted(lotId: string): DomainEvent {
  return { type: CATALOG_EVENTS.lotSubmitted, aggregateId: lotId, payload: { lotId } };
}

/** La obra entro al catalogo publico: desde ahora se ve en la galeria de quien la publico. */
export function lotListed(lotId: string): DomainEvent {
  return { type: CATALOG_EVENTS.lotListed, aggregateId: lotId, payload: { lotId } };
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

/** El administrador devolvio la obra: el vendedor recibe el motivo para corregirla. */
export function lotReturnedToDraft(lot: Pick<Lot, 'id' | 'sellerId' | 'title'>, reason: string): DomainEvent {
  return {
    type: CATALOG_EVENTS.lotReturnedToDraft,
    aggregateId: lot.id,
    payload: { lotId: lot.id, sellerId: lot.sellerId, title: lot.title, reason },
  };
}
