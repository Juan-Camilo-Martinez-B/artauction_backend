import { recordInbox, sqlExecutorFrom } from '@artauction/platform';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import { isSupport, type Artwork, type CustomizationStatus, type PersonalGallery } from '../domain/gallery';
import type { GalleryPatch, GalleryRepository } from '../application/ports';

const GALLERY_SCHEMA = 'gallery';
const DEFAULT_NAME = 'Mi galería';
const include = { artworks: { orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.PersonalGalleryInclude;

type GalleryRow = Prisma.PersonalGalleryGetPayload<{ include: typeof include }>;

function record(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value) : null;
}

function status(value: string): CustomizationStatus {
  return value === 'PERSONALIZADA' || value === 'EDITADA' ? value : 'SIN_PERSONALIZAR';
}

function toGallery(row: GalleryRow): PersonalGallery {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    customizationStatus: status(row.customizationStatus),
    preferences: record(row.preferences) ?? {},
    suggestedConfig: record(row.suggestedConfig),
    appliedConfig: record(row.appliedConfig),
    artworks: row.artworks.map(
      (artwork): Artwork => ({
        id: artwork.id,
        lotId: artwork.lotId,
        posX: artwork.posX,
        posY: artwork.posY,
        posZ: artwork.posZ,
        rotY: artwork.rotY,
        scale: artwork.scale,
        support: isSupport(artwork.support) ? artwork.support : 'WALL',
      }),
    ),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class PrismaGalleryRepository implements GalleryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async mine(ownerId: string): Promise<PersonalGallery> {
    const existing = await this.find(ownerId);
    if (existing) {
      return existing;
    }
    try {
      return toGallery(await this.prisma.personalGallery.create({ data: { ownerId, name: DEFAULT_NAME }, include }));
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return toGallery(await this.prisma.personalGallery.findUniqueOrThrow({ where: { ownerId }, include }));
    }
  }

  async find(ownerId: string): Promise<PersonalGallery | null> {
    const row = await this.prisma.personalGallery.findUnique({ where: { ownerId }, include });
    return row ? toGallery(row) : null;
  }

  async update(galleryId: string, patch: GalleryPatch): Promise<void> {
    await this.prisma.personalGallery.update({
      where: { id: galleryId },
      data: {
        ...(patch.preferences ? { preferences: json(patch.preferences) } : {}),
        ...(patch.suggestedConfig ? { suggestedConfig: json(patch.suggestedConfig), configVersion: 1 } : {}),
        ...(patch.appliedConfig ? { appliedConfig: json(patch.appliedConfig) } : {}),
        ...(patch.customizationStatus ? { customizationStatus: patch.customizationStatus } : {}),
      },
    });
  }

  async addArtwork(galleryId: string, lotId: string, placement: Omit<Artwork, 'id' | 'lotId'>): Promise<void> {
    try {
      await this.prisma.personalGalleryArtwork.create({ data: { galleryId, lotId, ...placement } });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  async removeArtwork(galleryId: string, lotId: string): Promise<void> {
    await this.prisma.personalGalleryArtwork.deleteMany({ where: { galleryId, lotId } });
  }

  async moveArtwork(artworkId: string, placement: Omit<Artwork, 'id' | 'lotId'>): Promise<void> {
    await this.prisma.personalGalleryArtwork.update({ where: { id: artworkId }, data: placement });
  }

  async follow(followerId: string, followeeId: string): Promise<boolean> {
    try {
      await this.prisma.follow.create({ data: { followerId, followeeId } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  async seen(eventId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT 1 FROM gallery.inbox WHERE event_id = ${eventId}`;
    return rows.length > 0;
  }

  async recordEvent(eventId: string, eventType: string): Promise<void> {
    await recordInbox(sqlExecutorFrom(this.prisma), GALLERY_SCHEMA, eventId, eventType);
  }
}
