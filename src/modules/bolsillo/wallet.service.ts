import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { COIN_PRICE_CENTS, inspectCard } from './payment-gateway';
import type { TopUpDto } from './dto';

export interface WalletSnapshot {
  balance: number;
  held: number;
  entries: Array<{ id: string; kind: string; coins: number; createdAt: string }>;
}

export interface TopUpResult {
  balance: number;
  credited: number;
  last4: string;
  orderId: string;
}

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(userId: string): Promise<WalletSnapshot> {
    const [wallet, held, entries] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId } }),
      this.prisma.bidHold.aggregate({ where: { bidderId: userId }, _sum: { coins: true } }),
      this.prisma.walletEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return {
      balance: wallet?.balance ?? 0,
      held: held._sum.coins ?? 0,
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        coins: entry.coins,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  async topUp(userId: string, input: TopUpDto, now = new Date()): Promise<TopUpResult> {
    const card = inspectCard(
      {
        number: input.cardNumber,
        expMonth: input.expMonth,
        expYear: input.expYear,
        cvv: input.cvv,
      },
      now,
    );
    const order = await this.prisma.paymentOrder.create({
      data: {
        userId,
        coins: input.coins,
        amountCents: input.coins * COIN_PRICE_CENTS,
        currency: 'USD',
        status: card.accepted ? 'APROBADO' : 'RECHAZADO',
        cardBrand: card.brand,
        cardLast4: card.last4,
      },
    });
    if (!card.accepted) {
      throw new BadRequestException('La pasarela rechazó la tarjeta.');
    }
    const wallet = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.wallet.upsert({
        where: { userId },
        create: { userId, balance: input.coins },
        update: { balance: { increment: input.coins } },
      });
      await tx.walletEntry.create({
        data: {
          userId,
          kind: 'RECARGA',
          coins: input.coins,
          paymentOrderId: order.id,
        },
      });
      return stored;
    });
    return { balance: wallet.balance, credited: input.coins, last4: card.last4, orderId: order.id };
  }
}
