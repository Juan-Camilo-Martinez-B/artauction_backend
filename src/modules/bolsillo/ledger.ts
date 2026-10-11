import { Prisma } from '@prisma/client';
import { holdIncrease } from '../subastas/auction-policy';

export class InsufficientCoinsError extends Error {
  constructor(readonly missing: number) {
    super(`No tienes artacoins suficientes. Faltan ${missing} en el bolsillo.`);
  }
}

export async function retainCoins(
  tx: Prisma.TransactionClient,
  input: { userId: string; auctionId: string; nextCoins: number },
): Promise<number> {
  await ensureWallet(tx, input.userId);
  const locked = await tx.$queryRaw<{ balance: number }[]>`
    SELECT balance
    FROM wallets
    WHERE user_id = CAST(${input.userId} AS uuid)
    FOR UPDATE
  `;
  const hold = await tx.bidHold.findUnique({
    where: { auctionId_bidderId: { auctionId: input.auctionId, bidderId: input.userId } },
  });
  const delta = holdIncrease(hold?.coins ?? 0, input.nextCoins);
  const balance = locked[0]?.balance ?? 0;
  if (balance < delta) {
    throw new InsufficientCoinsError(delta - balance);
  }
  await tx.wallet.update({
    where: { userId: input.userId },
    data: { balance: { decrement: delta } },
  });
  await tx.bidHold.upsert({
    where: { auctionId_bidderId: { auctionId: input.auctionId, bidderId: input.userId } },
    create: { auctionId: input.auctionId, bidderId: input.userId, coins: input.nextCoins },
    update: { coins: input.nextCoins },
  });
  await tx.walletEntry.create({
    data: {
      userId: input.userId,
      kind: 'RETENCION',
      coins: delta,
      auctionId: input.auctionId,
    },
  });
  return delta;
}

export async function releaseHold(
  tx: Prisma.TransactionClient,
  input: { userId: string; auctionId: string },
): Promise<number> {
  const hold = await tx.bidHold.findUnique({
    where: { auctionId_bidderId: { auctionId: input.auctionId, bidderId: input.userId } },
  });
  if (!hold) {
    return 0;
  }
  await ensureWallet(tx, input.userId);
  await tx.wallet.update({
    where: { userId: input.userId },
    data: { balance: { increment: hold.coins } },
  });
  await tx.bidHold.delete({
    where: { auctionId_bidderId: { auctionId: input.auctionId, bidderId: input.userId } },
  });
  await tx.walletEntry.create({
    data: {
      userId: input.userId,
      kind: 'LIBERACION',
      coins: hold.coins,
      auctionId: input.auctionId,
    },
  });
  return hold.coins;
}

export async function settleHolds(
  tx: Prisma.TransactionClient,
  input: { auctionId: string; winnerId: string | null },
): Promise<void> {
  const holds = await tx.bidHold.findMany({ where: { auctionId: input.auctionId } });
  for (const hold of holds) {
    if (input.winnerId && hold.bidderId === input.winnerId) {
      await tx.bidHold.delete({
        where: { auctionId_bidderId: { auctionId: hold.auctionId, bidderId: hold.bidderId } },
      });
      await tx.walletEntry.create({
        data: {
          userId: hold.bidderId,
          kind: 'CANJE',
          coins: hold.coins,
          auctionId: input.auctionId,
        },
      });
      continue;
    }
    await releaseHold(tx, { userId: hold.bidderId, auctionId: input.auctionId });
  }
}

async function ensureWallet(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO wallets (user_id, balance)
    VALUES (CAST(${userId} AS uuid), 0)
    ON CONFLICT (user_id) DO NOTHING
  `;
}
