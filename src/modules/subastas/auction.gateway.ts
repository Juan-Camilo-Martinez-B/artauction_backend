import { Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ENV, type Environment } from '../../common/config/environment';
import { AuctionBus, type BidRejectedEvent } from './auction-bus';
import { BidsService } from './bids.service';

interface AccessPayload {
  sub: string;
  email: string;
  role: string;
}

@WebSocketGateway({
  cors: { origin: (process.env['CORS_ORIGINS'] ?? 'http://localhost:3000').split(',') },
})
export class AuctionGateway implements OnGatewayInit {
  private readonly logger = new Logger(AuctionGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly bids: BidsService,
    private readonly bus: AuctionBus,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Environment,
  ) {}

  afterInit(): void {
    this.bus.onBidAccepted((event) => {
      const server = this.server as Server | undefined;
      server?.to(`auction:${event.auctionId}`).emit('bid:accepted', event);
    });
    this.bus.onAuctionClosed((event) => {
      const server = this.server as Server | undefined;
      server?.to(`auction:${event.auctionId}`).emit('auction:closed', event);
    });
  }

  handleConnection(client: Socket): void {
    const token = readToken(client);
    if (!token) {
      client.disconnect();
      return;
    }
    try {
      // JwtService prioriza el secret del modulo sobre options.publicKey; por eso
      // la clave publica RS256 se pasa como options.secret, que va primero.
      const publicKey = this.env.identityPublicKey;
      const payload: unknown = publicKey
        ? this.jwt.verify(token, { secret: publicKey, algorithms: ['RS256'] })
        : this.jwt.verify(token, { secret: this.env.JWT_ACCESS_SECRET, algorithms: ['HS256'] });
      if (!isAccessPayload(payload)) {
        client.disconnect();
        return;
      }
      client.data = { userId: payload.sub, email: payload.email, role: payload.role };
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : 'token inválido');
      client.disconnect();
    }
  }

  @SubscribeMessage('auction:join')
  join(@ConnectedSocket() client: Socket, @MessageBody() auctionId: string): { serverTime: string } {
    void client.join(`auction:${auctionId}`);
    const serverTime = new Date().toISOString();
    client.emit('serverTime', { version: 1, serverTime });
    return { serverTime };
  }

  @SubscribeMessage('bid:place')
  async place(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { auctionId?: string; amount?: string; idempotencyKey?: string },
  ): Promise<{ ok: true; bidId: string } | BidRejectedEvent> {
    const userId = readUserId(client);
    if (!userId || !body.auctionId || !body.amount || !body.idempotencyKey) {
      return reject(body.auctionId ?? '', 'Puja incompleta');
    }
    try {
      const placed = await this.bids.placeBid({
        auctionId: body.auctionId,
        bidderId: userId,
        amount: body.amount,
        idempotencyKey: body.idempotencyKey,
      });
      return { ok: true, bidId: placed.bidId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Puja rechazada';
      const event = reject(body.auctionId, message);
      client.emit('bid:rejected', event);
      return event;
    }
  }
}

function reject(auctionId: string, message: string): BidRejectedEvent {
  return { version: 1, auctionId, message, serverTime: new Date().toISOString() };
}

function readToken(client: Socket): string | null {
  const auth: unknown = client.handshake.auth;
  if (typeof auth !== 'object' || auth === null || !('token' in auth)) {
    return null;
  }
  return typeof auth.token === 'string' ? auth.token : null;
}

function readUserId(client: Socket): string | null {
  const data: unknown = client.data;
  if (typeof data !== 'object' || data === null || !('userId' in data)) {
    return null;
  }
  return typeof data.userId === 'string' ? data.userId : null;
}

function isAccessPayload(value: unknown): value is AccessPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'sub' in value &&
    typeof value.sub === 'string' &&
    'email' in value &&
    typeof value.email === 'string' &&
    'role' in value &&
    typeof value.role === 'string'
  );
}
