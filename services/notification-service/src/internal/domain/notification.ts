// Avisos para los usuarios. Cada aviso nace de un evento; su id combina el
// evento y el destinatario, asi repetir el evento no duplica el aviso.

/**
 * AUCTION_CLOSED la reciben el ganador y el vendedor; AUCTION_LOST, quienes
 * pujaron en una sala que cerro sin ganarla (lo retenido ya les volvio).
 */
export type NotificationKind = 'AUDIT' | 'AUCTION_CLOSED' | 'AUCTION_LOST' | 'LOT_RETURNED';

export interface Notification {
  id: string;
  userId: string;
  kind: NotificationKind;
  payload: Record<string, string | null>;
  createdAt: Date;
  readAt: Date | null;
}

export function notificationId(eventId: string, userId: string): string {
  return `${eventId}:${userId}`;
}

/** Resultado de la auditoria: solo lo recibe el vendedor. */
export function auditFinished(input: { eventId: string; lotId: string; sellerId: string; verdict: string; now: Date }): Notification[] {
  return [
    {
      id: notificationId(input.eventId, input.sellerId),
      userId: input.sellerId,
      kind: 'AUDIT',
      payload: { lotId: input.lotId, verdict: input.verdict },
      createdAt: input.now,
      readAt: null,
    },
  ];
}

/** Cierre de subasta: lo reciben el vendedor y, si lo hay, el ganador. */
export function auctionClosed(input: {
  eventId: string;
  auctionId: string;
  lotId: string;
  sellerId: string;
  winnerId: string | null;
  amount: string;
  /** Cerro por compra inmediata y no por tiempo. */
  buyNow?: boolean;
  losingBidderIds?: readonly string[];
  now: Date;
}): Notification[] {
  const closedBy = input.buyNow === true ? 'BUY_NOW' : 'TIME';
  const payload = { auctionId: input.auctionId, lotId: input.lotId, winnerId: input.winnerId, amount: input.amount, closedBy };
  const recipients = [...new Set(input.winnerId ? [input.sellerId, input.winnerId] : [input.sellerId])];
  const parties: Notification[] = recipients.map((userId) => ({
    id: notificationId(input.eventId, userId),
    userId,
    kind: 'AUCTION_CLOSED',
    payload,
    createdAt: input.now,
    readAt: null,
  }));
  // Ni el vendedor ni el ganador reciben dos avisos del mismo cierre.
  const losers = [...new Set(input.losingBidderIds ?? [])].filter((userId) => !recipients.includes(userId));
  return [
    ...parties,
    ...losers.map(
      (userId): Notification => ({
        id: notificationId(input.eventId, userId),
        userId,
        kind: 'AUCTION_LOST',
        payload,
        createdAt: input.now,
        readAt: null,
      }),
    ),
  ];
}

/** Obra devuelta a borrador: el vendedor recibe el motivo para corregirla. */
export function lotReturned(input: { eventId: string; lotId: string; sellerId: string; title: string; reason: string; now: Date }): Notification[] {
  return [
    {
      id: notificationId(input.eventId, input.sellerId),
      userId: input.sellerId,
      kind: 'LOT_RETURNED',
      payload: { lotId: input.lotId, title: input.title, reason: input.reason },
      createdAt: input.now,
      readAt: null,
    },
  ];
}
