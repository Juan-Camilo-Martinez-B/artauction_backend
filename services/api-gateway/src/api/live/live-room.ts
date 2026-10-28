import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { auctionV1 } from '@artauction/contracts';
import { isServiceError, toHttpError, type StructuredLogger, type TokenVerifier } from '@artauction/platform';
import { invoke } from '@artauction/service-kit';
import { RoomStreams, type RoomNotice, type WatchSource } from './room-streams';

// Contrato de eventos del frontend (src/lib/ws/events.ts). Se mantiene igual
// al que servia el monolito.

interface BidRejectedEvent {
  version: 1;
  auctionId: string;
  message: string;
  serverTime: string;
}

type BidAck = { ok: true; bidId: string } | BidRejectedEvent;

interface PlaceBidMessage {
  auctionId?: unknown;
  amount?: unknown;
  idempotencyKey?: unknown;
}

interface SocketState {
  userId: string;
  token: string;
  rooms: Set<string>;
  bidTimes: number[];
}

export interface LiveRoomOptions {
  corsOrigins: string[];
  deadlineMs: number;
  /** Salas que un socket puede mirar a la vez; al pasarse se suelta la mas antigua. */
  maxRoomsPerSocket?: number;
  /** Pujas por socket dentro de la ventana de `bidWindowMs`. */
  maxBidsPerWindow?: number;
  bidWindowMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function now(): string {
  return new Date().toISOString();
}

function reject(auctionId: string, message: string): BidRejectedEvent {
  return { version: 1, auctionId, message, serverTime: now() };
}

function roomName(auctionId: string): string {
  return `auction:${auctionId}`;
}

function readToken(socket: Socket): string | null {
  const auth: unknown = socket.handshake.auth;
  if (typeof auth !== 'object' || auth === null || !('token' in auth)) {
    return null;
  }
  return typeof auth.token === 'string' && auth.token.length > 0 ? auth.token : null;
}

function state(socket: Socket): SocketState {
  return socket.data as SocketState;
}

/**
 * Sala en vivo por Socket.IO sobre el servidor HTTP del gateway. Autentica el
 * socket con el token RS256 de identity-service, reenvia las pujas a
 * auction-service con el token del usuario y difunde a cada sala los avisos
 * del stream WatchAuction, abierto una sola vez por sala.
 *
 * Limite conocido: el stream llega de una sola instancia de auction-service
 * (F6). Con varias instancias, los avisos tendrian que pasar por un bus comun.
 */
export class LiveRoom {
  private io: Server | null = null;
  private readonly streams: RoomStreams;
  private readonly maxRooms: number;
  private readonly maxBids: number;
  private readonly bidWindowMs: number;

  constructor(
    private readonly auctions: auctionV1.AuctionServiceClient,
    source: WatchSource,
    private readonly verifier: TokenVerifier,
    private readonly logger: StructuredLogger,
    private readonly options: LiveRoomOptions,
  ) {
    this.streams = new RoomStreams(source, (auctionId, notice) => {
      this.broadcast(auctionId, notice);
    }, logger);
    this.maxRooms = options.maxRoomsPerSocket ?? 10;
    this.maxBids = options.maxBidsPerWindow ?? 20;
    this.bidWindowMs = options.bidWindowMs ?? 10_000;
  }

  attach(httpServer: HttpServer): void {
    const io = new Server(httpServer, {
      cors: { origin: this.options.corsOrigins, credentials: true },
      maxHttpBufferSize: 16 * 1024,
    });
    io.use((socket, next) => {
      const token = readToken(socket);
      try {
        const principal = token ? this.verifier.verify(token) : null;
        if (!token || principal?.kind !== 'user') {
          next(new Error('No autorizado'));
          return;
        }
        const initial: SocketState = { userId: principal.userId, token, rooms: new Set(), bidTimes: [] };
        socket.data = initial;
        next();
      } catch {
        next(new Error('No autorizado'));
      }
    });
    io.on('connection', (socket) => {
      socket.on('auction:join', (auctionId: unknown, ack?: unknown) => {
        const reply = this.join(socket, auctionId);
        if (typeof ack === 'function') {
          (ack as (value: unknown) => void)(reply);
        }
      });
      socket.on('bid:place', (body: unknown, ack?: unknown) => {
        void this.place(socket, body).then((reply) => {
          if (typeof ack === 'function') {
            (ack as (value: unknown) => void)(reply);
          }
        });
      });
      socket.on('disconnect', () => {
        for (const auctionId of state(socket).rooms) {
          this.streams.release(auctionId);
        }
        state(socket).rooms.clear();
      });
    });
    this.io = io;
  }

  /** Corta streams y sockets; el servidor HTTP lo cierra Nest. */
  close(): void {
    this.streams.closeAll();
    if (this.io) {
      this.io.disconnectSockets(true);
      this.io.engine.close();
      this.io = null;
    }
  }

  private join(socket: Socket, auctionId: unknown): { serverTime: string } {
    const serverTime = now();
    if (typeof auctionId === 'string' && UUID.test(auctionId)) {
      const rooms = state(socket).rooms;
      if (!rooms.has(auctionId)) {
        if (rooms.size >= this.maxRooms) {
          const oldest = rooms.values().next().value;
          if (oldest !== undefined) {
            this.leave(socket, oldest);
          }
        }
        rooms.add(auctionId);
        void socket.join(roomName(auctionId));
        this.streams.acquire(auctionId);
      }
    }
    socket.emit('serverTime', { version: 1, serverTime });
    return { serverTime };
  }

  private leave(socket: Socket, auctionId: string): void {
    state(socket).rooms.delete(auctionId);
    void socket.leave(roomName(auctionId));
    this.streams.release(auctionId);
  }

  private async place(socket: Socket, raw: unknown): Promise<BidAck> {
    const body: PlaceBidMessage = typeof raw === 'object' && raw !== null ? raw : {};
    const auctionId = typeof body.auctionId === 'string' ? body.auctionId : '';
    const { amount, idempotencyKey } = body;
    if (!UUID.test(auctionId) || typeof amount !== 'string' || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      return reject(auctionId, 'Puja incompleta');
    }
    if (!this.withinRate(state(socket))) {
      const event = reject(auctionId, 'Demasiadas pujas seguidas; espera unos segundos.');
      socket.emit('bid:rejected', event);
      return event;
    }
    const token = state(socket).token;
    try {
      this.verifier.verify(token);
    } catch {
      // El token del socket se fija al conectar y caduca antes que la sesion.
      // El frontend envia la misma puja tambien por REST con un token fresco y
      // la misma clave de idempotencia, asi que aqui no se anuncia un rechazo.
      return reject(auctionId, 'La sesion del socket expiro');
    }
    try {
      const placed = await invoke(
        this.auctions.placeBid.bind(this.auctions),
        { auctionId, amount, idempotencyKey },
        { deadlineMs: this.options.deadlineMs, authorization: `Bearer ${token}` },
      );
      return { ok: true, bidId: placed.bidId };
    } catch (error) {
      if (!isServiceError(error)) {
        this.logger.error(error instanceof Error ? error.message : String(error), undefined, 'live-room');
      }
      const event = reject(auctionId, toHttpError(error).message);
      socket.emit('bid:rejected', event);
      return event;
    }
  }

  /** Ventana deslizante por socket; acota pujas automatizadas desde un cliente. */
  private withinRate(socketState: SocketState): boolean {
    const current = Date.now();
    const recent = socketState.bidTimes.filter((time) => current - time < this.bidWindowMs);
    if (recent.length >= this.maxBids) {
      socketState.bidTimes = recent;
      return false;
    }
    recent.push(current);
    socketState.bidTimes = recent;
    return true;
  }

  private broadcast(auctionId: string, notice: RoomNotice): void {
    const io = this.io;
    const event = notice.event;
    if (!io || !event) {
      return;
    }
    const serverTime = (notice.serverTime ?? new Date()).toISOString();
    const room = io.to(roomName(auctionId));
    if (event.$case === 'bidAccepted') {
      const bid = event.value;
      room.emit('bid:accepted', {
        version: 1,
        auctionId: bid.auctionId,
        bidId: bid.bidId,
        bidderId: bid.bidderId,
        amount: bid.amount,
        endsAt: (bid.endsAt ?? new Date()).toISOString(),
        extended: bid.extended,
        serverTime,
      });
      return;
    }
    const closed = event.value;
    room.emit('auction:closed', {
      version: 1,
      auctionId: closed.auctionId,
      lotId: closed.lotId,
      winnerId: closed.winnerId ?? null,
      amount: closed.amount,
      serverTime,
    });
  }
}
