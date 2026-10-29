import { recordInbox, sqlExecutorFrom } from '@artauction/platform';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import { confirmHold, type EntryKind, type WalletSnapshot } from '../domain/wallet';
import type {
  HoldState,
  LedgerTransaction,
  NewTopUp,
  Reservation,
  ReservationPlan,
  SaleSettlement,
  TopUpRecord,
  WalletRepository,
} from '../application/ports';

export const WALLET_SCHEMA = 'wallet';

type Tx = Prisma.TransactionClient;

const UNIQUE_VIOLATION = 'P2002';
const ENTRY_KINDS: ReadonlySet<string> = new Set(['RECARGA', 'RETENCION', 'LIBERACION', 'CANJE', 'VENTA']);

/**
 * Bloquea el bolsillo de cada usuario (creandolo en cero si no existe) y
 * devuelve sus saldos. Bloquea en orden de id: dos transacciones que tocan los
 * mismos bolsillos nunca se esperan en sentidos opuestos (sin deadlocks).
 */
async function lockWallets(tx: Tx, userIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(userIds)].sort();
  const balances = new Map<string, number>();
  for (const userId of ids) {
    await tx.$executeRaw`INSERT INTO wallet.wallets (user_id, balance) VALUES (CAST(${userId} AS uuid), 0) ON CONFLICT (user_id) DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ balance: number }>>`
      SELECT balance FROM wallet.wallets WHERE user_id = CAST(${userId} AS uuid) FOR UPDATE`;
    balances.set(userId, rows[0]?.balance ?? 0);
  }
  return balances;
}

async function addToBalance(tx: Tx, userId: string, coins: number): Promise<number> {
  const wallet = await tx.wallet.update({ where: { userId }, data: { balance: { increment: coins } } });
  return wallet.balance;
}

async function entry(tx: Tx, userId: string, kind: EntryKind, coins: number, refs: { auctionId?: string; paymentOrderId?: string } = {}) {
  if (coins > 0) {
    await tx.walletEntry.create({ data: { userId, kind, coins, ...refs } });
  }
}

/** Devuelve una reserva PENDIENTE al saldo. Asume el bolsillo ya bloqueado. */
async function releasePending(tx: Tx, reservation: { reservationId: string; bidderId: string; auctionId: string; reservedCoins: number }) {
  const changed = await tx.holdReservation.updateMany({
    where: { reservationId: reservation.reservationId, status: 'PENDIENTE' },
    data: { status: 'LIBERADA' },
  });
  if (changed.count === 1) {
    await addToBalance(tx, reservation.bidderId, reservation.reservedCoins);
    await entry(tx, reservation.bidderId, 'LIBERACION', reservation.reservedCoins, { auctionId: reservation.auctionId });
  }
  return changed.count === 1;
}

function ledgerIn(tx: Tx): LedgerTransaction {
  const pendingOf = (reservationId: string) =>
    tx.holdReservation.findFirst({ where: { reservationId, status: 'PENDIENTE' } });

  return {
    async confirmReservation(reservationId) {
      const reservation = await pendingOf(reservationId);
      if (!reservation) {
        return false;
      }
      await lockWallets(tx, [reservation.bidderId]);
      const changed = await tx.holdReservation.updateMany({
        where: { reservationId, status: 'PENDIENTE' },
        data: { status: 'CONFIRMADA' },
      });
      if (changed.count !== 1) {
        return false;
      }
      // La retencion es absoluta por postor y subasta: queda en la mayor oferta
      // confirmada, y lo reservado de mas vuelve al saldo.
      const key = { auctionId_bidderId: { auctionId: reservation.auctionId, bidderId: reservation.bidderId } };
      const current = await tx.bidHold.findUnique({ where: key });
      const { hold, refund } = confirmHold(current?.coins ?? 0, reservation);
      await tx.bidHold.upsert({
        where: key,
        create: { auctionId: reservation.auctionId, bidderId: reservation.bidderId, coins: hold },
        update: { coins: hold },
      });
      if (refund > 0) {
        await addToBalance(tx, reservation.bidderId, refund);
        await entry(tx, reservation.bidderId, 'LIBERACION', refund, { auctionId: reservation.auctionId });
      }
      return true;
    },

    async releaseReservation(reservationId) {
      const reservation = await pendingOf(reservationId);
      if (!reservation) {
        return false;
      }
      await lockWallets(tx, [reservation.bidderId]);
      return releasePending(tx, reservation);
    },

    async releaseBidderHold(auctionId, bidderId) {
      await lockWallets(tx, [bidderId]);
      let released = 0;
      for (const reservation of await tx.holdReservation.findMany({ where: { auctionId, bidderId, status: 'PENDIENTE' } })) {
        if (await releasePending(tx, reservation)) {
          released += reservation.reservedCoins;
        }
      }
      const hold = await tx.bidHold.findUnique({ where: { auctionId_bidderId: { auctionId, bidderId } } });
      if (hold) {
        await tx.bidHold.delete({ where: { auctionId_bidderId: { auctionId, bidderId } } });
        await addToBalance(tx, bidderId, hold.coins);
        await entry(tx, bidderId, 'LIBERACION', hold.coins, { auctionId });
        released += hold.coins;
      }
      return released;
    },

    async settleAuction(auctionId, winnerId, sale) {
      const holds = await tx.bidHold.findMany({ where: { auctionId } });
      const pending = await tx.holdReservation.findMany({ where: { auctionId, status: 'PENDIENTE' } });
      await lockWallets(tx, [...holds.map((hold) => hold.bidderId), ...pending.map((item) => item.bidderId), ...(sale ? [sale.sellerId] : [])]);

      // El outbox de auction entrega cada BidAccepted antes que el cierre de su
      // subasta: una reserva aun pendiente aqui es de una puja que no se guardo.
      for (const reservation of pending) {
        await releasePending(tx, reservation);
      }
      for (const hold of holds) {
        await tx.bidHold.delete({ where: { auctionId_bidderId: { auctionId, bidderId: hold.bidderId } } });
        if (winnerId !== null && hold.bidderId === winnerId) {
          await entry(tx, hold.bidderId, 'CANJE', hold.coins, { auctionId });
        } else {
          await addToBalance(tx, hold.bidderId, hold.coins);
          await entry(tx, hold.bidderId, 'LIBERACION', hold.coins, { auctionId });
        }
      }
      if (sale) {
        await creditSale(tx, auctionId, sale);
      }
    },
  };
}

async function creditSale(tx: Tx, auctionId: string, sale: SaleSettlement): Promise<void> {
  const inserted = await tx.$executeRaw`
    INSERT INTO wallet.platform_fees (auction_id, seller_id, gross_coins, fee_coins)
    VALUES (CAST(${auctionId} AS uuid), CAST(${sale.sellerId} AS uuid), ${sale.grossCoins}, ${sale.feeCoins})
    ON CONFLICT (auction_id) DO NOTHING`;
  if (inserted === 1) {
    await addToBalance(tx, sale.sellerId, sale.netCoins);
    await entry(tx, sale.sellerId, 'VENTA', sale.netCoins, { auctionId });
  }
}

export class PrismaWalletRepository implements WalletRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async snapshot(userId: string, entryLimit: number): Promise<WalletSnapshot> {
    const [wallet, holds, pending, entries] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId } }),
      this.prisma.bidHold.aggregate({ where: { bidderId: userId }, _sum: { coins: true } }),
      this.prisma.holdReservation.aggregate({ where: { bidderId: userId, status: 'PENDIENTE' }, _sum: { reservedCoins: true } }),
      this.prisma.walletEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: entryLimit }),
    ]);
    return {
      balance: wallet?.balance ?? 0,
      held: (holds._sum.coins ?? 0) + (pending._sum.reservedCoins ?? 0),
      entries: entries
        .filter((row) => ENTRY_KINDS.has(row.kind))
        .map((row) => ({ id: row.id, kind: row.kind as EntryKind, coins: row.coins, createdAt: row.createdAt })),
    };
  }

  async findTopUp(userId: string, idempotencyKey: string): Promise<TopUpRecord | null> {
    const order = await this.prisma.paymentOrder.findFirst({ where: { userId, idempotencyKey } });
    return order ? toTopUp(order) : null;
  }

  async recordTopUp(input: NewTopUp): Promise<{ record: TopUpRecord; created: boolean; balance: number }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.paymentOrder.create({
          data: {
            userId: input.userId,
            coins: input.coins,
            amountCents: input.amountCents,
            currency: 'USD',
            status: input.approved ? 'APROBADO' : 'RECHAZADO',
            cardBrand: input.brand,
            cardLast4: input.last4,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          },
        });
        let balance = (await lockWallets(tx, [input.userId])).get(input.userId) ?? 0;
        if (input.approved) {
          balance = await addToBalance(tx, input.userId, input.coins);
          await entry(tx, input.userId, 'RECARGA', input.coins, { paymentOrderId: order.id });
        }
        return { record: toTopUp(order), created: true, balance };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Otra peticion con la misma clave gano la carrera: se devuelve su orden.
      const winner = await this.findTopUp(input.userId, input.idempotencyKey);
      if (!winner) {
        throw error;
      }
      return { record: winner, created: false, balance: await this.balance(input.userId) };
    }
  }

  async balance(userId: string): Promise<number> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    return wallet?.balance ?? 0;
  }

  async reserve(
    input: { reservationId: string; auctionId: string; bidderId: string },
    plan: (state: HoldState) => ReservationPlan,
  ): Promise<{ reservedCoins: number; balance: number }> {
    const existing = await this.prisma.holdReservation.findUnique({ where: { reservationId: input.reservationId } });
    if (existing) {
      return { reservedCoins: existing.reservedCoins, balance: await this.balance(input.bidderId) };
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const balance = (await lockWallets(tx, [input.bidderId])).get(input.bidderId) ?? 0;
        const hold = await tx.bidHold.findUnique({
          where: { auctionId_bidderId: { auctionId: input.auctionId, bidderId: input.bidderId } },
        });
        const decided = plan({ balance, previousCoins: hold?.coins ?? 0, existing: null });
        await tx.holdReservation.create({
          data: {
            reservationId: input.reservationId,
            auctionId: input.auctionId,
            bidderId: input.bidderId,
            previousCoins: decided.previousCoins,
            nextCoins: decided.nextCoins,
            reservedCoins: decided.reservedCoins,
            expiresAt: decided.expiresAt,
          },
        });
        const next = await addToBalance(tx, input.bidderId, -decided.reservedCoins);
        await entry(tx, input.bidderId, 'RETENCION', decided.reservedCoins, { auctionId: input.auctionId });
        return { reservedCoins: decided.reservedCoins, balance: next };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const winner = await this.prisma.holdReservation.findUniqueOrThrow({ where: { reservationId: input.reservationId } });
      return { reservedCoins: winner.reservedCoins, balance: await this.balance(input.bidderId) };
    }
  }

  applyOnce(eventId: string, eventType: string, work: (ledger: LedgerTransaction) => Promise<void>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await recordInbox(sqlExecutorFrom(tx), WALLET_SCHEMA, eventId, eventType))) {
        return false;
      }
      await work(ledgerIn(tx));
      return true;
    });
  }

  async expiredReservations(now: Date, limit: number): Promise<Reservation[]> {
    const rows = await this.prisma.holdReservation.findMany({
      where: { status: 'PENDIENTE', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      reservationId: row.reservationId,
      auctionId: row.auctionId,
      bidderId: row.bidderId,
      reservedCoins: row.reservedCoins,
      expiresAt: row.expiresAt,
    }));
  }

  resolveReservation(reservationId: string, decision: 'CONFIRM' | 'RELEASE'): Promise<boolean> {
    return this.prisma.$transaction((tx) => {
      const ledger = ledgerIn(tx);
      return decision === 'CONFIRM' ? ledger.confirmReservation(reservationId) : ledger.releaseReservation(reservationId);
    });
  }
}

function toTopUp(order: {
  id: string;
  userId: string;
  coins: number;
  status: string;
  cardLast4: string;
  requestHash: string | null;
}): TopUpRecord {
  return {
    orderId: order.id,
    userId: order.userId,
    coins: order.coins,
    approved: order.status === 'APROBADO',
    last4: order.cardLast4,
    requestHash: order.requestHash,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}
