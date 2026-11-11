import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { status } from '@grpc/grpc-js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { auctionV1 } from '@artauction/contracts';
import { DomainError, loadConfig, StructuredLogger } from '@artauction/platform';
import { startGrpcServer, unary, type RunningServer } from '@artauction/service-kit';
import { grpcWatchSource, RoomStreams, type RoomNotice, type WatchSource } from '../src/api/live/room-streams';
import { createGateway } from '../src/app';
import { GatewayConfig } from '../src/config';

const logger = new StructuredLogger('test', () => undefined);
const AUCTION_ID = '0b9f0f4e-6a4c-4f0a-9d55-6f1d8f1f0a01';
const LOT_ID = '5f2a4d1c-9a51-4c8b-8f3d-2a1e7c9b0d02';

describe('RoomStreams', () => {
  /** Fuente falsa: guarda cada stream abierto para cortarlo o enviarle avisos. */
  function fakeSource() {
    const opened: Array<{ auctionId: string; push: (notice: RoomNotice) => void; end: (error?: Error) => void; cancelled: boolean }> = [];
    const source: WatchSource = {
      watch(auctionId, onNotice, onEnd) {
        const entry = { auctionId, push: onNotice, end: onEnd, cancelled: false };
        opened.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    };
    return { source, opened };
  }

  it('abre un solo stream por sala y lo cierra al salir el ultimo miembro', () => {
    const { source, opened } = fakeSource();
    const streams = new RoomStreams(source, () => undefined, logger);
    streams.acquire(AUCTION_ID);
    streams.acquire(AUCTION_ID);
    expect(opened).toHaveLength(1);
    expect(streams.watching(AUCTION_ID)).toBe(2);
    streams.release(AUCTION_ID);
    expect(opened[0]?.cancelled).toBe(false);
    streams.release(AUCTION_ID);
    expect(opened[0]?.cancelled).toBe(true);
    expect(streams.watching(AUCTION_ID)).toBe(0);
  });

  it('entrega los avisos con el id de la sala', () => {
    const { source, opened } = fakeSource();
    const received: string[] = [];
    const streams = new RoomStreams(source, (auctionId) => received.push(auctionId), logger);
    streams.acquire(AUCTION_ID);
    opened[0]?.push(auctionV1.WatchAuctionResponse.fromPartial({ serverTime: new Date() }));
    expect(received).toEqual([AUCTION_ID]);
  });

  it('reabre el stream con backoff si se corta y la sala sigue con miembros', () => {
    jest.useFakeTimers();
    try {
      const { source, opened } = fakeSource();
      const streams = new RoomStreams(source, () => undefined, logger, { baseRetryMs: 100, maxRetryMs: 1_000 });
      streams.acquire(AUCTION_ID);
      opened[0]?.end(new Error('UNAVAILABLE'));
      jest.advanceTimersByTime(99);
      expect(opened).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(opened).toHaveLength(2);
      opened[1]?.end(new Error('UNAVAILABLE'));
      jest.advanceTimersByTime(199);
      expect(opened).toHaveLength(2);
      jest.advanceTimersByTime(1);
      expect(opened).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('no reabre el stream si la sala quedo vacia durante el corte', () => {
    jest.useFakeTimers();
    try {
      const { source, opened } = fakeSource();
      const streams = new RoomStreams(source, () => undefined, logger, { baseRetryMs: 100 });
      streams.acquire(AUCTION_ID);
      opened[0]?.end(new Error('UNAVAILABLE'));
      streams.release(AUCTION_ID);
      jest.advanceTimersByTime(10_000);
      expect(opened).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('grpcWatchSource', () => {
  it('avisa el fin una sola vez aunque el stream emita error y end', () => {
    const call = new EventEmitter() as EventEmitter & { cancel: () => void };
    call.cancel = () => undefined;
    const client = { watchAuction: () => call } as unknown as auctionV1.AuctionServiceClient;
    const ends: Array<Error | undefined> = [];
    grpcWatchSource(client).watch(AUCTION_ID, () => undefined, (error) => ends.push(error));
    call.emit('error', Object.assign(new Error('14 UNAVAILABLE: stream timeout'), { code: status.UNAVAILABLE }));
    call.emit('end');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.message).toContain('UNAVAILABLE');
  });

  it('con error y end seguidos la sala reabre un solo stream', () => {
    jest.useFakeTimers();
    try {
      const calls: Array<EventEmitter & { cancel: () => void }> = [];
      const client = {
        watchAuction: () => {
          const call = Object.assign(new EventEmitter(), { cancel: () => undefined });
          calls.push(call);
          return call;
        },
      } as unknown as auctionV1.AuctionServiceClient;
      const streams = new RoomStreams(grpcWatchSource(client), () => undefined, logger, { baseRetryMs: 100 });
      streams.acquire(AUCTION_ID);
      calls[0]?.emit('error', Object.assign(new Error('UNAVAILABLE'), { code: status.UNAVAILABLE }));
      calls[0]?.emit('end');
      jest.advanceTimersByTime(1_000);
      expect(calls).toHaveLength(2);
      streams.closeAll();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('rutas /auctions sobre auction-service', () => {
  let auctionServer: RunningServer;
  let gateway: NestExpressApplication;
  let base: string;
  const placed: Array<{ request: auctionV1.PlaceBidRequest; authorization: string | undefined }> = [];
  const liveRequests: auctionV1.ListLiveAuctionsRequest[] = [];

  beforeAll(async () => {
    const auction = auctionV1.Auction.fromPartial({
      id: AUCTION_ID,
      lotId: LOT_ID,
      sellerId: 'seller-1',
      startPrice: '800',
      currentPrice: '850',
      minIncrement: '50',
      currency: 'ATC',
      startsAt: new Date('2026-10-28T10:00:00Z'),
      endsAt: new Date('2026-10-28T10:05:00Z'),
      initialEndsAt: new Date('2026-10-28T10:05:00Z'),
      status: auctionV1.AuctionStatus.AUCTION_STATUS_ACTIVA,
      extensionCount: 0,
      durationMinutes: 5,
      bids: [{ id: 'b1', auctionId: AUCTION_ID, bidderId: 'u2', amount: '850', active: true, createdAt: new Date('2026-10-28T10:01:00Z') }],
    });
    const implementation: auctionV1.AuctionServiceServer = {
      getAuction: unary(logger, 'GetAuction', (request) =>
        request.auctionId === AUCTION_ID
          ? Promise.resolve(auctionV1.GetAuctionResponse.fromPartial({ auction, serverTime: new Date('2026-10-28T10:02:00Z') }))
          : Promise.reject(DomainError.notFound('Subasta no encontrada')),
      ),
      openAuction: unary(logger, 'OpenAuction', () => Promise.resolve(auctionV1.OpenAuctionResponse.fromPartial({ auction }))),
      placeBid: unary(logger, 'PlaceBid', (request, context) => {
        placed.push({ request, authorization: context.authorization });
        return request.amount === '10'
          ? Promise.reject(DomainError.invalid('La puja debe superar el precio actual'))
          : Promise.resolve(
              auctionV1.PlaceBidResponse.fromPartial({
                bidId: 'b2',
                auctionId: AUCTION_ID,
                amount: request.amount,
                endsAt: new Date('2026-10-28T10:05:30Z'),
                extended: true,
                idempotent: false,
                currentPrice: request.amount,
              }),
            );
      }),
      buyNow: unary(logger, 'BuyNow', (request) =>
        Promise.resolve(
          auctionV1.BuyNowResponse.fromPartial({ auctionId: request.auctionId, bidId: 'b9', amount: '2400.00', idempotent: false }),
        ),
      ),
      withdrawBid: unary(logger, 'WithdrawBid', () =>
        Promise.resolve(auctionV1.WithdrawBidResponse.fromPartial({ auctionId: AUCTION_ID, releasedCoins: 850, currentPrice: '800' })),
      ),
      batchGetAuctionSummaries: unary(logger, 'BatchGetAuctionSummaries', () =>
        Promise.resolve(auctionV1.BatchGetAuctionSummariesResponse.fromPartial({})),
      ),
      listLiveAuctions: unary(logger, 'ListLiveAuctions', (request) => {
        liveRequests.push(request);
        return Promise.resolve(auctionV1.ListLiveAuctionsResponse.fromPartial({}));
      }),
      getBidByReservation: unary(logger, 'GetBidByReservation', () =>
        Promise.resolve(auctionV1.GetBidByReservationResponse.fromPartial({})),
      ),
      watchAuction: (call) => {
        call.end();
      },
    };
    auctionServer = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      tls: { enabled: false },
      logger,
      services: [{ name: 'auction', definition: auctionV1.AuctionServiceService, implementation }],
    });
    const config = loadConfig(GatewayConfig, { PORT: '3999', AUCTION_GRPC_URL: `127.0.0.1:${String(auctionServer.port)}` });
    gateway = await createGateway(config, logger);
    await gateway.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${String((gateway.getHttpServer().address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await gateway.close();
    await auctionServer.shutdown();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-de-prueba' },
      body: JSON.stringify(body),
    });

  it('devuelve la sala con la hora del servidor y sin claves de idempotencia', async () => {
    const response = await fetch(`${base}/auctions/${AUCTION_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { auction: Record<string, unknown>; serverTime: string };
    expect(body.serverTime).toBe('2026-10-28T10:02:00.000Z');
    expect(body.auction).toMatchObject({
      id: AUCTION_ID,
      lotId: LOT_ID,
      startPrice: '800',
      currentPrice: '850',
      status: 'ACTIVA',
      winnerId: null,
      endsAt: '2026-10-28T10:05:00.000Z',
    });
    expect(body.auction['bids']).toEqual([
      { id: 'b1', auctionId: AUCTION_ID, bidderId: 'u2', amount: '850', active: true, createdAt: '2026-10-28T10:01:00.000Z', buyNow: false },
    ]);
  });

  it('sirve la cartelera en /auctions/live sin confundirla con un id', async () => {
    const response = await fetch(`${base}/auctions/live?limit=6&horizonMinutes=90`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], serverTime: expect.any(String) as unknown });
    expect(liveRequests.at(-1)).toEqual({ limit: 6, horizonMinutes: 90 });
    expect((await fetch(`${base}/auctions/live?limit=99`)).status).toBe(400);
  });

  it('traduce la subasta inexistente a 404 y rechaza ids que no son uuid', async () => {
    expect((await fetch(`${base}/auctions/${LOT_ID}`)).status).toBe(404);
    expect((await fetch(`${base}/auctions/no-es-uuid`)).status).toBe(400);
  });

  it('reenvia la puja con el token del usuario y responde la forma del frontend', async () => {
    const response = await post(`/auctions/${AUCTION_ID}/bids`, { amount: '900', idempotencyKey: 'clave-puja-0001' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      bidId: 'b2',
      auctionId: AUCTION_ID,
      amount: '900',
      endsAt: '2026-10-28T10:05:30.000Z',
      extended: true,
      idempotent: false,
      currentPrice: '900',
    });
    expect(placed.at(-1)).toEqual({
      request: { auctionId: AUCTION_ID, amount: '900', idempotencyKey: 'clave-puja-0001' },
      authorization: 'Bearer token-de-prueba',
    });
  });

  it('valida la puja antes de llamar al servicio y traduce sus rechazos', async () => {
    const calls = placed.length;
    expect((await post(`/auctions/${AUCTION_ID}/bids`, { amount: '900', idempotencyKey: 'corta' })).status).toBe(400);
    expect((await post(`/auctions/${AUCTION_ID}/bids`, { amount: 'mil', idempotencyKey: 'clave-puja-0002' })).status).toBe(400);
    expect(placed).toHaveLength(calls);
    const rejected = await post(`/auctions/${AUCTION_ID}/bids`, { amount: '10', idempotencyKey: 'clave-puja-0003' });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ message: 'La puja debe superar el precio actual' });
  });

  it('compra ahora con clave de idempotencia y la exige', async () => {
    const response = await post(`/auctions/${AUCTION_ID}/buy-now`, { idempotencyKey: 'compra-0001' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ auctionId: AUCTION_ID, bidId: 'b9', amount: '2400.00', idempotent: false });
    expect((await post(`/auctions/${AUCTION_ID}/buy-now`, {})).status).toBe(400);
  });

  it('devuelve el retiro con las artacoins liberadas', async () => {
    const response = await post(`/auctions/${AUCTION_ID}/withdraw`, {});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ auctionId: AUCTION_ID, released: 850, currentPrice: '800' });
  });
});
