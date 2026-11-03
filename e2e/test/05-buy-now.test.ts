import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { BASE_URL, call, eventually, idempotencyKey, register, seedAccount, type Account } from '../src/platform.ts';

interface WalletView {
  balance: number;
  held: number;
}

interface AuctionView {
  auction: { status: string; winnerId: string | null; currentPrice: string; buyNowPrice: string; buyNowAvailable: boolean; closedBy: string | null };
}

interface CatalogPage {
  items: Array<{ id: string; sellerId: string; status: string; auction: { status: string } | null }>;
}

const CARD = { cardNumber: '4242424242424242', cardName: 'E2E Comprador', expMonth: 12, expYear: 2030, cvv: '123' };

// Compra inmediata: quien paga el precio de compra se lleva la obra y la sala
// cierra al instante; a los demas postores se les devuelve lo retenido.
describe('compra inmediata', () => {
  let seller: Account;
  let buyer: Account;
  let bidder: Account;
  let auctionId: string;
  let lotId: string;
  let sellerBefore = 0;
  let socket: Socket;
  const closedEvents: Array<Record<string, unknown>> = [];

  const wallet = async (account: Account) => (await call<WalletView>('GET', '/wallet', { token: account.token })).body;
  const auction = async () => (await call<AuctionView>('GET', `/auctions/${auctionId}`)).body.auction;

  before(async () => {
    seller = await seedAccount(process.env['E2E_SELLER_EMAIL'] ?? 'seller@artauction.local');
    buyer = await register('comprador', 'USER');
    bidder = await register('postor-c', 'USER');
    const page = await call<CatalogPage>('GET', '/lots?pageSize=60');
    const free = page.body.items.filter(
      (lot) => lot.sellerId === seller.userId && ['APROBADO', 'PUBLICADA'].includes(lot.status) && (lot.auction === null || lot.auction.status === 'PROGRAMADA'),
    );
    free.sort((left, right) => Number(left.auction !== null) - Number(right.auction !== null));
    assert.ok(free.length >= 1, 'la semilla no tiene obras libres para la compra inmediata');
    lotId = free[0]?.id ?? '';
    sellerBefore = (await wallet(seller)).balance;
    for (const [account, coins] of [[buyer, 400], [bidder, 200]] as const) {
      const topped = await call('POST', '/wallet/top-ups', {
        token: account.token,
        headers: { 'idempotency-key': idempotencyKey('recarga') },
        body: { coins, ...CARD },
      });
      assert.equal(topped.status, 201);
    }
  });

  after(() => {
    socket.close();
  });

  test('la sala abre con su precio de compra inmediata: la salida por 3', async () => {
    const now = Date.now();
    const opened = await call<{ id: string }>('POST', '/auctions', {
      token: seller.token,
      body: { lotId, startPrice: '100', minIncrement: '10', startsAt: new Date(now + 8_000).toISOString(), endsAt: new Date(now + 180_000).toISOString() },
    });
    assert.equal(opened.status, 201);
    auctionId = opened.body.id;
    assert.equal((await auction()).buyNowPrice, '300.00');
    // Programada: todavia no se puede comprar.
    assert.equal((await auction()).buyNowAvailable, false);
    assert.equal((await call('POST', `/auctions/${auctionId}/buy-now`, { token: buyer.token, body: { idempotencyKey: idempotencyKey('temprano') } })).status, 409);
    await eventually('la sala se abre', async () => (await auction()).status === 'ACTIVA', 40_000);
    assert.equal((await auction()).buyNowAvailable, true);
  });

  test('alguien puja y el vendedor no puede comprar su obra', async () => {
    socket = await new Promise<Socket>((resolve, reject) => {
      const client = io(BASE_URL, { transports: ['websocket'], auth: { token: bidder.token }, reconnection: false });
      client.on('connect', () => {
        resolve(client);
      });
      client.on('connect_error', reject);
    });
    socket.on('auction:closed', (event: Record<string, unknown>) => closedEvents.push(event));
    await socket.emitWithAck('auction:join', auctionId);

    const bid = await call('POST', `/auctions/${auctionId}/bids`, { token: bidder.token, body: { amount: '100', idempotencyKey: idempotencyKey('puja-c') } });
    assert.equal(bid.status, 201);
    assert.equal((await wallet(bidder)).held, 100);
    assert.equal((await call('POST', `/auctions/${auctionId}/buy-now`, { token: seller.token, body: { idempotencyKey: idempotencyKey('propia') } })).status, 403);
  });

  test('comprar ahora cierra la sala, cobra una sola vez y devuelve lo retenido a los demas', async () => {
    const key = idempotencyKey('compra');
    const bought = await call<{ amount: string; idempotent: boolean }>('POST', `/auctions/${auctionId}/buy-now`, { token: buyer.token, body: { idempotencyKey: key } });
    assert.equal(bought.status, 201);
    assert.deepEqual({ amount: bought.body.amount, idempotent: bought.body.idempotent }, { amount: '300.00', idempotent: false });
    const replay = await call<{ idempotent: boolean }>('POST', `/auctions/${auctionId}/buy-now`, { token: buyer.token, body: { idempotencyKey: key } });
    assert.equal(replay.body.idempotent, true);

    const closed = await auction();
    assert.deepEqual(
      { status: closed.status, winnerId: closed.winnerId, closedBy: closed.closedBy, price: closed.currentPrice, available: closed.buyNowAvailable },
      { status: 'CERRADA', winnerId: buyer.userId, closedBy: 'BUY_NOW', price: '300.00', available: false },
    );
    // Llega tarde: la sala ya cerro.
    assert.equal((await call('POST', `/auctions/${auctionId}/buy-now`, { token: bidder.token, body: { idempotencyKey: idempotencyKey('tarde') } })).status, 409);

    const settled = await eventually('wallet liquida la compra', async () => {
      const state = { buyer: await wallet(buyer), bidder: await wallet(bidder), seller: await wallet(seller) };
      return state.buyer.held === 0 && state.bidder.held === 0 && state.seller.balance > sellerBefore ? state : null;
    });
    assert.equal(settled.buyer.balance, 100, 'el comprador paga 300 una sola vez');
    assert.equal(settled.bidder.balance, 200, 'al postor se le devuelve lo retenido');
    assert.equal(settled.seller.balance - sellerBefore, 270, 'el vendedor cobra menos la comision del 10 %');
    await eventually('la sala avisa en vivo que cerro por compra inmediata', () => Promise.resolve(closedEvents.some((event) => event['closedBy'] === 'BUY_NOW')));
  });

  test('avisos, feed y galeria del comprador', async () => {
    type Notice = { kind: string; payload: Record<string, string | null> };
    const notesOf = async (account: Account) => (await call<Notice[]>('GET', '/notifications', { token: account.token })).body;
    const mine = await eventually('el comprador recibe su aviso', async () => (await notesOf(buyer)).find((note) => note.payload['auctionId'] === auctionId));
    assert.deepEqual({ kind: mine.kind, closedBy: mine.payload['closedBy'] }, { kind: 'AUCTION_CLOSED', closedBy: 'BUY_NOW' });
    const lost = await eventually('el postor recibe que la sala cerro', async () => (await notesOf(bidder)).find((note) => note.payload['auctionId'] === auctionId));
    assert.equal(lost.kind, 'AUCTION_LOST');
    await eventually('el vendedor recibe su aviso', async () => (await notesOf(seller)).some((note) => note.kind === 'AUCTION_CLOSED' && note.payload['auctionId'] === auctionId));

    await eventually('el feed publica la compra inmediata', async () => {
      const feed = await call<Array<{ verb: string; objectId: string }>>('GET', '/feed', { token: bidder.token });
      return feed.body.some((item) => item.verb === 'BUY_NOW' && item.objectId === lotId);
    });
    await eventually('la obra pasa a la galeria del comprador', async () => {
      const items = await call<Array<{ lotId: string; source: string }>>('GET', `/galleries/${buyer.userId}`, { token: buyer.token });
      return items.body.some((item) => item.lotId === lotId && item.source === 'GANADA');
    });
  });
});
