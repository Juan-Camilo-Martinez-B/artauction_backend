import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Prisma } from '@prisma/client';
import type { Model } from 'mongoose';
import { canViewGalleryItem } from '../../common/domain/visibility';
import type { GalleryGrants } from '../../common/outcomes';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { Activity } from './activity.schema';
import { GalleryItem } from './gallery-item.schema';

@Injectable()
export class GaleriasService implements GalleryGrants {
  constructor(
    private readonly prisma: PrismaService,
    @InjectModel(GalleryItem.name) private readonly items: Model<GalleryItem>,
    @InjectModel(Activity.name) private readonly activity: Model<Activity>,
  ) {}

  async grantOwnLot(input: { ownerId: string; lotId: string }): Promise<void> {
    const lot = await this.prisma.lot.findUnique({
      where: { id: input.lotId },
      include: { images: true },
    });
    if (!lot || lot.sellerId !== input.ownerId) {
      return;
    }
    await this.items.create({
      ownerId: input.ownerId,
      lotId: lot.id,
      source: 'PROPIA',
      visibility: 'PRIVATE',
      title: lot.title,
      artistName: lot.artistName,
      imageKeys: lot.images.map((image) => image.objectKey),
      acquiredAt: new Date(),
    });
  }

  async grantWonLot(input: { ownerId: string; lotId: string }): Promise<void> {
    const lot = await this.prisma.lot.findUnique({
      where: { id: input.lotId },
      include: { images: true },
    });
    if (!lot) {
      return;
    }
    await this.items.create({
      ownerId: input.ownerId,
      lotId: lot.id,
      source: 'GANADA',
      visibility: 'PRIVATE',
      title: lot.title,
      artistName: lot.artistName,
      imageKeys: lot.images.map((image) => image.objectKey),
      acquiredAt: new Date(),
    });
    await this.activity.create({
      actorId: input.ownerId,
      verb: 'WIN',
      objectType: 'LOT',
      objectId: lot.id,
      visibility: 'PUBLIC',
      summary: `Ganó ${lot.title}`,
      createdAt: new Date(),
    });
  }

  async listForViewer(ownerId: string, viewerId: string | null) {
    const items = await this.items.find({ ownerId }).sort({ acquiredAt: -1 }).lean().exec();
    return items.filter((item) => canViewGalleryItem({ visibility: item.visibility, ownerId: item.ownerId }, viewerId));
  }

  async follow(followerId: string, followeeId: string): Promise<void> {
    if (followerId === followeeId) {
      throw new BadRequestException('No puedes seguirte a ti mismo');
    }
    const followee = await this.prisma.user.findUnique({ where: { id: followeeId } });
    if (!followee) {
      throw new NotFoundException('Usuario no encontrado');
    }
    try {
      await this.prisma.follow.create({ data: { followerId, followeeId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return;
      }
      throw error;
    }
    await this.activity.create({
      actorId: followerId,
      verb: 'FOLLOW',
      objectType: 'USER',
      objectId: followeeId,
      visibility: 'PUBLIC',
      summary: `Siguió a ${followee.displayName}`,
      createdAt: new Date(),
    });
  }

  feed(viewerId: string) {
    return this.activity
      .find({ $or: [{ visibility: 'PUBLIC' }, { actorId: viewerId }] })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
      .exec();
  }
}
