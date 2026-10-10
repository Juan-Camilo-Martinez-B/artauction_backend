import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/postgres/prisma.service';
import {
  GalleryDesignError,
  configsDiffer,
  validateGalleryConfig,
  type GalleryConfig,
  type GalleryPreferences,
} from './gallery-design';
import { GALLERY_DESIGN, preferencesFromBody, type GalleryDesignPort } from './gallery-design.port';

const PUBLIC_STATUSES = ['APROBADO', 'EN_SUBASTA', 'CERRADO'];
const galleryInclude = {
  artworks: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      lot: {
        include: {
          images: { orderBy: { position: 'asc' as const } },
          categories: { include: { category: true } },
        },
      },
    },
  },
} satisfies Prisma.PersonalGalleryInclude;

@Injectable()
export class GaleriaPersonalService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(GALLERY_DESIGN) private readonly design: GalleryDesignPort,
  ) {}

  async mine(ownerId: string) {
    const existing = await this.prisma.personalGallery.findUnique({
      where: { ownerId },
      include: galleryInclude,
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.prisma.personalGallery.create({
        data: { ownerId, name: 'Mi galería' },
        include: galleryInclude,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.personalGallery.findUniqueOrThrow({ where: { ownerId }, include: galleryInclude });
      }
      throw error;
    }
  }

  async savePreferences(ownerId: string, body: unknown, random: boolean) {
    const preferences = this.readPreferences(body, random);
    const gallery = await this.mine(ownerId);
    return this.prisma.personalGallery.update({
      where: { id: gallery.id },
      data: { preferences: preferences as unknown as Prisma.InputJsonValue },
      include: galleryInclude,
    });
  }

  async generate(ownerId: string, body: unknown, random: boolean, replaceApplied: boolean) {
    const preferences = this.readPreferences(body, random);
    const gallery = await this.mine(ownerId);
    let config: GalleryConfig;
    try {
      config = random
        ? await this.design.design(preferences).then((value) => ({ ...value, source: 'random' as const }))
        : await this.design.design(preferences);
      config = validateGalleryConfig(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo diseñar la galería.';
      throw new BadRequestException(message);
    }
    const manual = gallery.customizationStatus === 'EDITADA' && configsDiffer(gallery.appliedConfig, gallery.suggestedConfig);
    if (manual && !replaceApplied) {
      throw new ConflictException('Hay cambios manuales. Confirma si quieres reemplazar la sala actual.');
    }
    return this.prisma.personalGallery.update({
      where: { id: gallery.id },
      data: {
        preferences: preferences as unknown as Prisma.InputJsonValue,
        suggestedConfig: config as unknown as Prisma.InputJsonValue,
        appliedConfig: config as unknown as Prisma.InputJsonValue,
        customizationStatus: 'PERSONALIZADA',
        configVersion: 1,
      },
      include: galleryInclude,
    });
  }

  async applyManual(ownerId: string, body: unknown) {
    const gallery = await this.owned(ownerId);
    let config: GalleryConfig;
    try {
      const record = body as { source?: string };
      if (typeof body === 'object' && body !== null) {
        record.source = 'manual';
      }
      config = validateGalleryConfig(body);
    } catch (error) {
      throw new BadRequestException(error instanceof GalleryDesignError ? error.message : 'Configuración inválida.');
    }
    return this.prisma.personalGallery.update({
      where: { id: gallery.id },
      data: {
        appliedConfig: config as unknown as Prisma.InputJsonValue,
        customizationStatus: 'EDITADA',
      },
      include: galleryInclude,
    });
  }

  async restoreSuggested(ownerId: string) {
    const gallery = await this.owned(ownerId);
    if (gallery.suggestedConfig === null) {
      throw new BadRequestException('Todavía no hay una propuesta de la IA.');
    }
    const config = validateGalleryConfig(gallery.suggestedConfig);
    return this.prisma.personalGallery.update({
      where: { id: gallery.id },
      data: {
        appliedConfig: config as unknown as Prisma.InputJsonValue,
        customizationStatus: 'PERSONALIZADA',
      },
      include: galleryInclude,
    });
  }

  async addArtwork(ownerId: string, lotId: string) {
    const gallery = await this.mine(ownerId);
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot || lot.visibility !== 'PUBLIC' || !PUBLIC_STATUSES.includes(lot.status)) {
      throw new NotFoundException('Obra no encontrada');
    }
    const count = gallery.artworks.length;
    const threeD = lot.representationKind === 'THREE_D';
    const column = count % 3;
    const data = {
      galleryId: gallery.id,
      lotId,
      posX: threeD ? -2 + column * 2 : -3.2 + column * 2.4,
      posY: threeD ? 0 : 1.55,
      posZ: threeD ? 0.4 : -(galleryRoomDepth(gallery.appliedConfig) / 2 - 0.08),
      rotY: 0,
      scale: 1,
      support: threeD ? 'PEDESTAL' : 'WALL',
    };
    try {
      await this.prisma.personalGalleryArtwork.create({ data });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }
    return this.owned(ownerId);
  }

  async removeArtwork(ownerId: string, lotId: string) {
    const gallery = await this.owned(ownerId);
    await this.prisma.personalGalleryArtwork.deleteMany({ where: { galleryId: gallery.id, lotId } });
    return this.owned(ownerId);
  }

  async placeArtwork(
    ownerId: string,
    lotId: string,
    patch: { posX?: number; posY?: number; posZ?: number; rotY?: number; scale?: number; support?: string },
  ) {
    const gallery = await this.owned(ownerId);
    const current = gallery.artworks.find((item) => item.lotId === lotId);
    if (!current) {
      throw new NotFoundException('La obra no está en tu galería');
    }
    const support = patch.support ?? current.support;
    if (!['WALL', 'PEDESTAL', 'FLOOR', 'PLATFORM', 'NICHE'].includes(support)) {
      throw new BadRequestException('Soporte no admitido.');
    }
    const scale = patch.scale ?? current.scale;
    if (scale <= 0 || scale > 3) {
      throw new BadRequestException('La escala está fuera de rango.');
    }
    await this.prisma.personalGalleryArtwork.update({
      where: { id: current.id },
      data: {
        posX: finite(patch.posX, current.posX),
        posY: finite(patch.posY, current.posY),
        posZ: finite(patch.posZ, current.posZ),
        rotY: finite(patch.rotY, current.rotY),
        scale,
        support,
      },
    });
    return this.owned(ownerId);
  }

  private readPreferences(body: unknown, random: boolean): GalleryPreferences {
    try {
      return preferencesFromBody(body, random);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Preferencias inválidas.');
    }
  }

  private async owned(ownerId: string) {
    const gallery = await this.prisma.personalGallery.findUnique({ where: { ownerId }, include: galleryInclude });
    if (!gallery) {
      throw new NotFoundException('Todavía no tienes galería.');
    }
    return gallery;
  }
}

function galleryRoomDepth(config: Prisma.JsonValue | null): number {
  if (typeof config !== 'object' || config === null || Array.isArray(config) || !('architecture' in config)) {
    return 10;
  }
  const architecture = config.architecture;
  if (typeof architecture !== 'object' || architecture === null || !('roomDepth' in architecture)) {
    return 10;
  }
  return typeof architecture.roomDepth === 'number' ? architecture.roomDepth : 10;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
