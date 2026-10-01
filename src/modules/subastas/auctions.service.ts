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
import type { OpenAuctionDto } from './dto';

@Injectable()
export class AuctionsService {
  constructor(private readonly prisma: PrismaService) {}

  async open(sellerId: string, input: OpenAuctionDto, now = new Date()) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
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
        if (lot.status !== 'APROBADO' || !canTransition(lot.status, 'EN_SUBASTA')) {
          throw new ConflictException('La obra no está lista para subastarse');
        }
        const activeNow = startsAt.getTime() <= now.getTime();
        const auction = await tx.auction.create({
          data: {
            lotId: lot.id,
            startPrice: centsToMoney(startCents),
            currentPrice: centsToMoney(startCents),
            minIncrement: centsToMoney(incrementCents),
            currency: 'USD',
            startsAt,
            endsAt,
            initialEndsAt: endsAt,
            status: activeNow ? 'ACTIVA' : 'PROGRAMADA',
          },
        });
        if (activeNow) {
          await tx.lot.update({ where: { id: lot.id }, data: { status: 'EN_SUBASTA' } });
        }
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
}
