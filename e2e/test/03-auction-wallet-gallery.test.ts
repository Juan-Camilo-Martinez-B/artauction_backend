import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { BASE_URL, call, eventually, idempotencyKey, register, seedAccount, sleep, type Account } from '../src/platform.ts';

interface WalletView {
  balance: number;
  held: number;
}

interface CatalogPage {
  items: Array<{ id: string; title: string; sellerId: string; status: string; auction: unknown }>;
}

const CARD = { cardNumber: '4242424242424242', cardName: 'E2E Postor', expMonth: 12, expYear: 2030, cvv: '123' };

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, { transports: ['websocket'], auth: { token }, reconnection: false });
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', reject);
  });
}

describe('bolsillo, sala en vivo, liquidacion y galeria', () => {
  let seller: Account;
  let buyerA: Account;
  let buyerB: Account;
  let lotId: string;
  let otherLotId: string;
  let auctionId: string;
  let socketB: Socket;
  const eventsB: Array<[string, Record<string, unknown>]> = [];
  let sellerBefore = 0;

  const wallet = async (account: Account) => (await call<WalletView>('GET', '/wallet', { token: account.token })).body;
  const topUp = (account: Account, coins: number, key: string) =>
    call<{ orderId: string; balance: number }>('POST', '/wallet/top-ups', {
      token: account.token,
      headers: { 'idempotency-key': key },
      body: { coins, ...CARD },
    });

  before(async () => {
    seller = await seedAccount(process.env['E2E_SELLER_EMAIL'] ?? 'seller@artauction.local');
    buyerA = await register('postor-a', 'USER');
    buyerB = await register('postor-b', 'USER');
    // Obras publicas de la semilla sin subasta: la prueba abre una sala inmediata.
    const page = await call<CatalogPage>('GET', '/lots?pageSize=60');
    const free = page.body.items.filter((lot) => lot.sellerId === seller.userId && ['APROBADO', 'PUBLICADA'].includes(lot.status) && lot.auction === null);
    assert.ok(free.length >= 2, 'la semilla no tiene obras libres para subastar');
    lotId = free[0]?.id ?? '';
    otherLotId = free[1]?.id ?? '';
    sellerBefore = (await wallet(seller)).balance;
  });

  after(() => {
    socketB.close();
  });

  test('la recarga es idempotente por clave y rechaza una clave reutilizada con otros datos', async () => {
    const key = idempotencyKey('recarga-b');
    const first = await topUp(buyerB, 500, key);
    const repeated = await topUp(buyerB, 500, key);
    assert.equal(first.status, 201);
    assert.equal(repeated.body.orderId, first.body.orderId);
    assert.equal((await wallet(buyerB)).balance, 500);
    assert.equal((await topUp(buyerB, 600, key)).status, 409);
    assert.equal((await topUp(buyerA, 300, idempotencyKey('recarga-a'))).status, 201);
  });

  test('el vendedor abre una sala y el programador la activa', async () => {
    const now = Date.now();
    const opened = await call<{ id: string }>('POST', '/auctions', {
      token: seller.token,
      body: { lotId, startPrice: '100', minIncrement: '10', startsAt: new Date(now + 8_000).toISOString(), endsAt: new Date(now + 55_000).toISOString() },
    });
    assert.equal(opened.status, 201);
    auctionId = opened.body.id;
    const forbidden = await call('POST', '/auctions', {
      token: buyerA.token,
      body: { lotId: otherLotId, startPrice: '100', minIncrement: '10', startsAt: new Date(now + 60_000).toISOString(), endsAt: new Date(now + 120_000).toISOString() },
    });
    assert.equal(forbidden.status, 403);
    await eventually('la sala se abre', async () => (await call<{ auction: { status: string } }>('GET', `/auctions/${auctionId}`)).body.auction.status === 'ACTIVA', 40_000);
  });

  test('pujas por REST y por Socket.IO con reserva TCC e idempotencia', async () => {
    socketB = await connect(buyerB.token);
    socketB.on('bid:accepted', (event: Record<string, unknown>) => eventsB.push(['bid:accepted', event]));
    socketB.on('auction:closed', (event: Record<string, unknown>) => eventsB.push(['auction:closed', event]));
    const joined = (await socketB.emitWithAck('auction:join', auctionId)) as { serverTime?: string };
    assert.ok(joined.serverTime);

    const keyA = idempotencyKey('puja-a');
    const bidA = await call<{ bidId: string; idempotent: boolean }>('POST', `/auctions/${auctionId}/bids`, { token: buyerA.token, body: { amount: '100', idempotencyKey: keyA } });
    assert.equal(bidA.status, 201);
    assert.equal((await wallet(buyerA)).held, 100);
    const replay = await call<{ bidId: string; idempotent: boolean }>('POST', `/auctions/${auctionId}/bids`, { token: buyerA.token, body: { amount: '100', idempotencyKey: keyA } });
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.bidId, bidA.body.bidId);
    assert.equal((await wallet(buyerA)).held, 100);

    assert.equal((await call('POST', `/auctions/${auctionId}/bids`, { token: buyerB.token, body: { amount: '105', idempotencyKey: idempotencyKey('baja') } })).status, 400);
    assert.notEqual((await call('POST', `/auctions/${auctionId}/bids`, { token: seller.token, body: { amount: '200', idempotencyKey: idempotencyKey('propia') } })).status, 201);

    const ack = (await socketB.emitWithAck('bid:place', { auctionId, amount: '120', idempotencyKey: idempotencyKey('puja-b') })) as { ok?: boolean };
    assert.equal(ack.ok, true);
    await eventually('el socket recibe las dos pujas aceptadas', () => Promise.resolve(eventsB.filter(([name]) => name === 'bid:accepted').length >= 2), 10_000);
  });

  test('al cerrar, el ganador paga, los demas recuperan su reserva y el vendedor cobra menos la comision', async () => {
    const closed = await eventually(
      'la sala cierra',
      async () => {
        const view = await call<{ auction: { status: string; winnerId: string | null; currentPrice: string } }>('GET', `/auctions/${auctionId}`);
        return view.body.auction.status === 'CERRADA' ? view.body.auction : null;
      },
      120_000,
    );
    assert.equal(closed.winnerId, buyerB.userId);
    assert.equal(closed.currentPrice, '120.00');
    await eventually('el socket recibe auction:closed', () => Promise.resolve(eventsB.some(([name]) => name === 'auction:closed')), 15_000);

    const settled = await eventually('wallet liquida la venta', async () => {
      const [a, b, s] = await Promise.all([wallet(buyerA), wallet(buyerB), wallet(seller)]);
      return a.held === 0 && b.held === 0 && s.balance > sellerBefore ? { a, b, s } : null;
    });
    assert.equal(settled.a.balance, 300);
    assert.equal(settled.b.balance, 380);
    assert.equal(settled.s.balance - sellerBefore, 108);
    assert.equal((await call('GET', `/lots/${lotId}`)).status, 404, 'la obra vendida deja el catalogo publico');
  });

  test('la obra ganada llega a la galeria del ganador, al feed y a los avisos', async () => {
    const won = await eventually('gallery-service registra la obra ganada', async () => {
      const items = await call<Array<{ lotId: string | null; source: string; imageKeys: string[] }>>('GET', `/galleries/${buyerB.userId}`, { token: buyerB.token });
      return items.body.find((item) => item.lotId === lotId && item.source === 'GANADA');
    });
    assert.ok(won.imageKeys.length > 0);
    await eventually('el feed publica la victoria', async () => {
      const feed = await call<Array<{ verb: string; objectId: string }>>('GET', '/feed', { token: buyerA.token });
      return feed.body.some((item) => item.verb === 'WIN' && item.objectId === lotId);
    });
    for (const account of [buyerB, seller]) {
      await eventually(`${account.email} recibe el aviso de cierre`, async () => {
        const notes = await call<Array<{ kind: string; payload: Record<string, string | null> }>>('GET', '/notifications', { token: account.token });
        return notes.body.some((note) => note.kind === 'AUCTION_CLOSED' && note.payload['auctionId'] === auctionId);
      });
    }
  });

  test('la sala 3D cuelga, mueve y descuelga obras publicas', async () => {
    const added = await call<{ artworks: Array<{ lotId: string; support: string; lot: { title: string } }> }>('POST', '/me/gallery/artworks', {
      token: buyerA.token,
      body: { lotId: otherLotId },
    });
    const hung = added.body.artworks.find((artwork) => artwork.lotId === otherLotId);
    assert.ok(hung?.lot.title, 'el gateway no compuso la ficha de la obra');
    const moved = await call<{ artworks: Array<{ lotId: string; support: string }> }>('PATCH', `/me/gallery/artworks/${otherLotId}`, {
      token: buyerA.token,
      body: { posX: 1.5, support: 'NICHE' },
    });
    assert.equal(moved.body.artworks.find((artwork) => artwork.lotId === otherLotId)?.support, 'NICHE');
    assert.equal((await call('PATCH', `/me/gallery/artworks/${otherLotId}`, { token: buyerA.token, body: { scale: 9 } })).status, 400);
    const removed = await call<{ artworks: Array<{ lotId: string }> }>('DELETE', `/me/gallery/artworks/${otherLotId}`, { token: buyerA.token });
    assert.ok(!removed.body.artworks.some((artwork) => artwork.lotId === otherLotId));
  });

  test('seguir a otro usuario aparece en el feed', async () => {
    assert.equal((await call('POST', `/users/${buyerB.userId}/follow`, { token: buyerA.token })).status, 201);
    assert.equal((await call('POST', `/users/${buyerA.userId}/follow`, { token: buyerA.token })).status, 400);
    await sleep(500);
    const feed = await call<Array<{ verb: string; actorId: string; objectId: string }>>('GET', '/feed', { token: buyerA.token });
    assert.ok(feed.body.some((item) => item.verb === 'FOLLOW' && item.actorId === buyerA.userId && item.objectId === buyerB.userId));
  });
});
