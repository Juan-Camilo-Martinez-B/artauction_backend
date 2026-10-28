import { status, type ServiceError } from '@grpc/grpc-js';
import type { auctionV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';

export type RoomNotice = auctionV1.WatchAuctionResponse;

/** Fuente de avisos en vivo de una sala. Devuelve la funcion que la cancela. */
export interface WatchSource {
  watch(auctionId: string, onNotice: (notice: RoomNotice) => void, onEnd: (error?: Error) => void): () => void;
}

/** Adaptador sobre el stream de servidor WatchAuction de auction-service. */
export function grpcWatchSource(client: auctionV1.AuctionServiceClient): WatchSource {
  return {
    watch(auctionId, onNotice, onEnd) {
      const call = client.watchAuction({ auctionId });
      let cancelled = false;
      call.on('data', onNotice);
      call.on('error', (error: ServiceError) => {
        if (!cancelled || error.code !== status.CANCELLED) {
          onEnd(error);
        }
      });
      call.on('end', () => {
        if (!cancelled) {
          onEnd();
        }
      });
      return () => {
        cancelled = true;
        call.cancel();
      };
    },
  };
}

interface Room {
  members: number;
  cancel: (() => void) | null;
  retry: NodeJS.Timeout | null;
  attempts: number;
}

export interface RoomStreamsOptions {
  baseRetryMs?: number;
  maxRetryMs?: number;
}

/**
 * Un solo stream WatchAuction por sala, compartido por todos los sockets que
 * la miran (conteo de referencias). Si el stream se corta mientras la sala
 * tiene miembros, se reabre con backoff exponencial; al salir el ultimo
 * miembro se cancela. Los avisos emitidos durante un corte se pierden: el
 * frontend recupera el estado con GET /auctions/:id al reconectar.
 */
export class RoomStreams {
  private readonly rooms = new Map<string, Room>();
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(
    private readonly source: WatchSource,
    private readonly onNotice: (auctionId: string, notice: RoomNotice) => void,
    private readonly logger: StructuredLogger,
    options: RoomStreamsOptions = {},
  ) {
    this.baseRetryMs = options.baseRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 15_000;
  }

  acquire(auctionId: string): void {
    const room = this.rooms.get(auctionId);
    if (room) {
      room.members += 1;
      return;
    }
    const created: Room = { members: 1, cancel: null, retry: null, attempts: 0 };
    this.rooms.set(auctionId, created);
    this.open(auctionId, created);
  }

  release(auctionId: string): void {
    const room = this.rooms.get(auctionId);
    if (!room) {
      return;
    }
    room.members -= 1;
    if (room.members > 0) {
      return;
    }
    this.stop(room);
    this.rooms.delete(auctionId);
  }

  watching(auctionId: string): number {
    return this.rooms.get(auctionId)?.members ?? 0;
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      this.stop(room);
    }
    this.rooms.clear();
  }

  private open(auctionId: string, room: Room): void {
    room.retry = null;
    room.cancel = this.source.watch(
      auctionId,
      (notice) => {
        room.attempts = 0;
        this.onNotice(auctionId, notice);
      },
      (error) => {
        room.cancel = null;
        if (this.rooms.get(auctionId) !== room) {
          return;
        }
        const delay = Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** room.attempts);
        room.attempts += 1;
        this.logger.warn(
          `stream de la sala ${auctionId} cortado (${error?.message ?? 'fin'}); reintento en ${String(delay)} ms`,
          'live-room',
        );
        room.retry = setTimeout(() => {
          this.open(auctionId, room);
        }, delay);
      },
    );
  }

  private stop(room: Room): void {
    if (room.retry) {
      clearTimeout(room.retry);
      room.retry = null;
    }
    room.cancel?.();
    room.cancel = null;
  }
}
