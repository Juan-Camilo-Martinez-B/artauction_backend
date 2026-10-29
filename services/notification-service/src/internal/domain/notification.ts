// Avisos para los usuarios. Cada aviso nace de un evento; su id combina el
// evento y el destinatario, asi repetir el evento no duplica el aviso.

export type NotificationKind = 'AUDIT' | 'AUCTION_CLOSED';

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
  now: Date;
}): Notification[] {
  const recipients = [...new Set(input.winnerId ? [input.sellerId, input.winnerId] : [input.sellerId])];
  return recipients.map((userId) => ({
    id: notificationId(input.eventId, userId),
    userId,
    kind: 'AUCTION_CLOSED',
    payload: { auctionId: input.auctionId, lotId: input.lotId, winnerId: input.winnerId, amount: input.amount },
    createdAt: input.now,
    readAt: null,
  }));
}
