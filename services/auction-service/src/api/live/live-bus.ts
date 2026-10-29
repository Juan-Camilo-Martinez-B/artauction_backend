import type { LiveFeed, LiveNotice } from '../../internal/application/ports';

type Listener = (notice: LiveNotice) => void;

/**
 * Bus en memoria de la sala en vivo. Cada sala guarda su conjunto de oyentes
 * (los streams WatchAuction abiertos); una sala sin oyentes se elimina.
 * Alcance: una instancia de auction-service (ver README).
 */
export class LiveBus implements LiveFeed {
  private readonly rooms = new Map<string, Set<Listener>>();

  publish(notice: LiveNotice): void {
    for (const listener of this.rooms.get(notice.auctionId) ?? []) {
      listener(notice);
    }
  }

  subscribe(auctionId: string, listener: Listener): () => void {
    const room = this.rooms.get(auctionId) ?? new Set<Listener>();
    room.add(listener);
    this.rooms.set(auctionId, room);
    return () => {
      room.delete(listener);
      if (room.size === 0) {
        this.rooms.delete(auctionId);
      }
    };
  }

  get openRooms(): number {
    return this.rooms.size;
  }
}
