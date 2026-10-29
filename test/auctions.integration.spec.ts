import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { type TestingModule, Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { EnvModule } from '../src/common/config/env.module';
import { MongoModule } from '../src/infra/mongo/mongo.module';
import { PrismaService } from '../src/infra/postgres/prisma.service';
import { PostgresModule } from '../src/infra/postgres/postgres.module';
import { CatalogoService } from '../src/modules/catalogo/catalogo.service';
import { CatalogoModule } from '../src/modules/catalogo/catalogo.module';
import { AuctionCloser } from '../src/modules/subastas/auction-closer';
import { AuctionsService } from '../src/modules/subastas/auctions.service';
import { BidsService } from '../src/modules/subastas/bids.service';
import { SubastasModule } from '../src/modules/subastas/subastas.module';

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??=
  'postgresql://artauction:artauction@127.0.0.1:54329/artauction?schema=public';
process.env['MONGODB_URI'] ??= 'mongodb://127.0.0.1:27018/artauction';
process.env['JWT_ACCESS_SECRET'] ??= 'ci-access-secret-value';
process.env['JWT_REFRESH_SECRET'] ??= 'ci-refresh-secret-value';
process.env['CORS_ORIGINS'] ??= 'http://localhost:3000';

describe('pujas y obras privadas', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let bids: BidsService;
  let auctions: AuctionsService;
  let closer: AuctionCloser;
  let catalogo: CatalogoService;
  const userIds: string[] = [];
  const lotIds: string[] = [];
  const auctionIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule,
        PostgresModule,
        MongoModule.forRoot(),
        CatalogoModule,
        SubastasModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    bids = moduleRef.get(BidsService);
    auctions = moduleRef.get(AuctionsService);
    closer = moduleRef.get(AuctionCloser);
    catalogo = moduleRef.get(CatalogoService);
  });

  afterAll(async () => {
    if (auctionIds.length > 0) {
      await prisma.auction.updateMany({
        where: { id: { in: auctionIds } },
        data: { winningBidId: null, winnerId: null },
      });
      await prisma.transaction.deleteMany({ where: { auctionId: { in: auctionIds } } });
      await prisma.bidHold.deleteMany({ where: { auctionId: { in: auctionIds } } });
      await prisma.walletEntry.deleteMany({ where: { auctionId: { in: auctionIds } } });
      await prisma.bid.deleteMany({ where: { auctionId: { in: auctionIds } } });
      await prisma.auction.deleteMany({ where: { id: { in: auctionIds } } });
    }
    if (lotIds.length > 0) {
      await prisma.auditSummary.deleteMany({ where: { lotId: { in: lotIds } } });
      await prisma.lotImage.deleteMany({ where: { lotId: { in: lotIds } } });
      await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
    }
    if (userIds.length > 0) {
      await prisma.bidHold.deleteMany({ where: { bidderId: { in: userIds } } });
      await prisma.walletEntry.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.paymentOrder.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.follow.deleteMany({
        where: { OR: [{ followerId: { in: userIds } }, { followeeId: { in: userIds } }] },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await moduleRef.close();
  });

  async function user(role: 'USER' | 'SELLER') {
    const created = await prisma.user.create({
      data: {
        email: `${randomUUID()}@fase2.test`,
        passwordHash: 'hash',
        displayName: 'Tester',
        role,
      },
    });
    userIds.push(created.id);
    return created;
  }

  async function liveAuction(endsAt: Date) {
    const seller = await user('SELLER');
    const bidder = await user('USER');
    const other = await user('USER');
    const lot = await prisma.lot.create({
      data: {
        sellerId: seller.id,
        title: 'Reloj de prueba',
        description: 'Lote creado para comprobar el candado de la puja.',
        materials: 'bronce',
        status: 'EN_SUBASTA',
        visibility: 'PUBLIC',
      },
    });
    lotIds.push(lot.id);
    const auction = await prisma.auction.create({
      data: {
        lotId: lot.id,
        startPrice: '100.00',
        currentPrice: '100.00',
        minIncrement: '10.00',
        startsAt: new Date(Date.now() - 60_000),
        endsAt,
        initialEndsAt: endsAt,
        status: 'ACTIVA',
      },
    });
    auctionIds.push(auction.id);
    await prisma.wallet.createMany({
      data: [
        { userId: bidder.id, balance: 100_000 },
        { userId: other.id, balance: 100_000 },
      ],
    });
    return { seller, bidder, other, lot, auction };
  }

  it('abre una obra aprobada y publica el reloj del servidor', async () => {
    const seller = await user('SELLER');
    const lot = await prisma.lot.create({
      data: {
        sellerId: seller.id,
        title: 'Óleo listo',
        description: 'Obra aprobada que sale a la sala enseguida.',
        materials: 'óleo',
        status: 'APROBADO',
        visibility: 'PUBLIC',
      },
    });
    lotIds.push(lot.id);
    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const auction = await auctions.open(seller.id, {
      lotId: lot.id,
      startPrice: '80.00',
      minIncrement: '5.00',
      startsAt,
      endsAt,
    });
    auctionIds.push(auction.id);
    const view = await auctions.getOne(auction.id);
    expect(view.auction.status).toBe('PROGRAMADA');
    expect(view.serverTime).toEqual(expect.any(String));
    expect(auction.startsAt.getTime()).toBeGreaterThan(Date.now());
    await expect(prisma.lot.findUniqueOrThrow({ where: { id: lot.id } })).resolves.toMatchObject({
      status: 'APROBADO',
    });
  });

  it('acepta una sola de dos pujas iguales y no deja bajar el precio', async () => {
    const { seller, bidder, other, auction } = await liveAuction(new Date(Date.now() + 120_000));
    const results = await Promise.allSettled([
      bids.placeBid({
        auctionId: auction.id,
        bidderId: bidder.id,
        amount: '100.00',
        idempotencyKey: `eq-a-${auction.id}`,
      }),
      bids.placeBid({
        auctionId: auction.id,
        bidderId: other.id,
        amount: '100.00',
        idempotencyKey: `eq-b-${auction.id}`,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const stored = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(Number(stored.currentPrice)).toBe(100);
    await expect(
      bids.placeBid({
        auctionId: auction.id,
        bidderId: other.id,
        amount: '90.00',
        idempotencyKey: `low-${auction.id}`,
      }),
    ).rejects.toThrow(/incremento/);
    const after = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(Number(after.currentPrice)).toBeGreaterThanOrEqual(100);
    await expect(
      bids.placeBid({
        auctionId: auction.id,
        bidderId: seller.id,
        amount: '200.00',
        idempotencyKey: `own-${auction.id}`,
      }),
    ).rejects.toThrow(/propia/);
  });

  it('repite la misma puja sin duplicarla y alarga el cierre', async () => {
    const endsAt = new Date(Date.now() + 10_000);
    const { bidder, auction } = await liveAuction(endsAt);
    const first = await bids.placeBid({
      auctionId: auction.id,
      bidderId: bidder.id,
      amount: '100.00',
      idempotencyKey: `once-${auction.id}`,
    });
    const replay = await bids.placeBid({
      auctionId: auction.id,
      bidderId: bidder.id,
      amount: '100.00',
      idempotencyKey: `once-${auction.id}`,
    });
    expect(replay.bidId).toBe(first.bidId);
    expect(replay.idempotent).toBe(true);
    expect(await prisma.bid.count({ where: { auctionId: auction.id } })).toBe(1);
    const stored = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(stored.endsAt.getTime()).toBeGreaterThanOrEqual(endsAt.getTime() + 30_000);
    expect(stored.extensionCount).toBe(1);
    await expect(
      bids.placeBid({
        auctionId: auction.id,
        bidderId: bidder.id,
        amount: '150.00',
        idempotencyKey: `once-${auction.id}`,
      }),
    ).rejects.toThrow(/reutilizada/);
  });

  it('oculta una obra privada a un tercero', async () => {
    const seller = await user('SELLER');
    const stranger = await user('USER');
    const lot = await catalogo.create(seller.id, {
      title: 'Boceto privado',
      description: 'Esta obra no debe aparecer para otros usuarios.',
      materials: 'grafito',
      categorySlug: 'pinturas',
      representationKind: 'TWO_D',
      widthCm: 21,
      heightCm: 29.7,
    });
    lotIds.push(lot.id);
    await expect(catalogo.getForViewer(lot.id, stranger.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(catalogo.getForViewer(lot.id, seller.id)).resolves.toMatchObject({ id: lot.id });
  });

  it('cierra una subasta vencida una sola vez', async () => {
    const { bidder, lot, auction } = await liveAuction(new Date(Date.now() - 1_000));
    await prisma.bid.create({
      data: {
        auctionId: auction.id,
        bidderId: bidder.id,
        amount: '100.00',
        idempotencyKey: `close-${auction.id}`,
      },
    });
    await expect(closer.closeOne(auction.id, new Date())).resolves.toBe(true);
    await expect(closer.closeOne(auction.id, new Date())).resolves.toBe(false);
    const stored = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    const closedLot = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(stored.status).toBe('CERRADA');
    expect(stored.winnerId).toBe(bidder.id);
    expect(closedLot.status).toBe('VENDIDA');
    expect(await prisma.transaction.count({ where: { auctionId: auction.id } })).toBe(1);
  });
});
