import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canTransition } from '../../common/domain/lot-state';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { centsToMoney, moneyToCents } from './bid-rules';
import {
  durationMinutes,
  incrementCoins,
  openingCoins,
  saleDescription,
  scheduleWindow,
} from './auction-policy';
import type { OpenAuctionDto } from './dto';

interface AuctionTerms {
  lotId: string;
  title: string;
  score: number;
  priceMin: number;
  priceMax: number;
  rationale: string;
}

@Injectable()
export class AuctionsService {
  constructor(private readonly prisma: PrismaService) {}

  async open(sellerId: string, input: OpenAuctionDto, now = new Date()) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (startsAt.getTime() <= now.getTime()) {
      throw new BadRequestException('La subasta no puede empezar en el pasado.');
    }
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new BadRequestException('El cierre debe ser posterior al inicio');
    }
    const startCents = moneyToCents(input.startPrice);
    const incrementCents = moneyToCents(input.minIncrement);
    if (startCents <= 0 || incrementCents <= 0) {
      throw new BadRequestException('El precio y el incremento deben ser positivos');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const lot = await tx.lot.findUnique({ where: { id: input.lotId } });
        if (!lot || lot.sellerId !== sellerId) {
          throw new NotFoundException('Obra no encontrada');
        }
        if (!['APROBADO', 'PUBLICADA'].includes(lot.status) || !canTransition(lot.status, 'EN_SUBASTA')) {
          throw new ConflictException('La obra no está lista para subastarse');
        }
        const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
        const auction = await tx.auction.create({
          data: {
            lotId: lot.id,
            startPrice: centsToMoney(startCents),
            currentPrice: centsToMoney(startCents),
            minIncrement: centsToMoney(incrementCents),
            currency: 'ATC',
            startsAt,
            endsAt,
            initialEndsAt: endsAt,
            status: 'PROGRAMADA',
            durationMinutes: Math.min(180, Math.max(30, minutes)),
          },
        });
        return auction;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Esa obra ya tiene subasta');
      }
      throw error;
    }
  }

  async getOne(auctionId: string) {
    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      include: { bids: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!auction) {
      throw new NotFoundException('Subasta no encontrada');
    }
    return { auction, serverTime: new Date().toISOString() };
  }

  async scheduleApproved(tx: Prisma.TransactionClient, input: AuctionTerms, now = new Date()) {
    const existing = await tx.auction.findUnique({ where: { lotId: input.lotId } });
    if (existing) {
      return existing;
    }
    const duration = durationMinutes(input.score);
    const opening = openingCoins(input.priceMin, input.priceMax);
    const increment = incrementCoins(opening);
    const window = scheduleWindow(now, duration);
    return tx.auction.create({
      data: {
        lotId: input.lotId,
        startPrice: centsToMoney(opening * 100),
        currentPrice: centsToMoney(opening * 100),
        minIncrement: centsToMoney(increment * 100),
        currency: 'ATC',
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        initialEndsAt: window.endsAt,
        status: 'PROGRAMADA',
        durationMinutes: duration,
        saleDescription: saleDescription(input.title, input.rationale),
      },
    });
  }

  async scheduleFromLot(lotId: string, now = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const lot = await tx.lot.findUnique({ where: { id: lotId } });
      if (!lot || !['PUBLICADA', 'APROBADO'].includes(lot.status)) {
        return null;
      }
      return this.scheduleApproved(
        tx,
        {
          lotId: lot.id,
          title: lot.title,
          score: lot.authenticityScore ?? 40,
          priceMin: Number(lot.suggestedPriceMin ?? 50),
          priceMax: Number(lot.suggestedPriceMax ?? 50),
          rationale: 'Aprobada en revisión manual.',
        },
        now,
      );
    });
  }
}
