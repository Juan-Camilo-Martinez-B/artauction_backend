import type { PrismaClient } from '../../generated/prisma';
import type { Activity, GalleryItem, PurchasedSheet } from '../domain/gallery';
import type { SocialStore } from '../application/ports';

/**
 * Galeria social y feed en gallery.items y gallery.activity. Las escrituras son
 * INSERT ... ON CONFLICT DO NOTHING sobre el id determinista: repetir un evento
 * no duplica ni pisa la fila, como hacia $setOnInsert en Mongo.
 */
export class PrismaSocialStore implements SocialStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertItem(id: string, item: GalleryItem): Promise<void> {
    await this.prisma.galleryItem.createMany({ data: [{ id, ...item }], skipDuplicates: true });
  }

  async itemsOf(ownerId: string): Promise<GalleryItem[]> {
    const rows = await this.prisma.galleryItem.findMany({ where: { ownerId }, orderBy: { acquiredAt: 'desc' } });
    return rows.map(toItem);
  }

  async itemOf(ownerId: string, lotId: string): Promise<GalleryItem | null> {
    const row = await this.prisma.galleryItem.findUnique({ where: { ownerId_lotId: { ownerId, lotId } } });
    return row ? toItem(row) : null;
  }

  async itemsOfLot(lotId: string): Promise<GalleryItem[]> {
    return (await this.prisma.galleryItem.findMany({ where: { lotId } })).map(toItem);
  }

  async updateItem(ownerId: string, lotId: string, patch: Partial<Pick<GalleryItem, 'source' | 'visibility'>>): Promise<void> {
    await this.prisma.galleryItem.updateMany({ where: { ownerId, lotId }, data: patch });
  }

  async removeItem(ownerId: string, lotId: string): Promise<void> {
    await this.prisma.galleryItem.deleteMany({ where: { ownerId, lotId } });
  }

  async sheetOf(ownerId: string, lotId: string): Promise<PurchasedSheet | null> {
    const row = await this.prisma.galleryItem.findUnique({ where: { ownerId_lotId: { ownerId, lotId } }, select: { sheet: true } });
    return toSheet(row?.sheet ?? null);
  }

  async saveSheet(ownerId: string, lotId: string, sheet: PurchasedSheet): Promise<void> {
    const document = { lot: sheet.lot, pricePaid: sheet.pricePaid, buyNow: sheet.buyNow, acquiredAt: sheet.acquiredAt.toISOString() };
    await this.prisma.galleryItem.updateMany({ where: { ownerId, lotId }, data: { sheet: document } });
  }

  async upsertActivity(id: string, activity: Activity): Promise<void> {
    await this.prisma.activity.createMany({ data: [{ id, ...activity }], skipDuplicates: true });
  }

  async feed(viewerId: string, limit: number): Promise<Activity[]> {
    const rows = await this.prisma.activity.findMany({
      where: { OR: [{ visibility: 'PUBLIC' }, { actorId: viewerId }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      actorId: row.actorId,
      verb: row.verb as Activity['verb'],
      objectType: row.objectType as Activity['objectType'],
      objectId: row.objectId,
      visibility: row.visibility as Activity['visibility'],
      summary: row.summary,
      createdAt: row.createdAt,
    }));
  }
}

function toItem(row: {
  ownerId: string;
  lotId: string;
  source: string;
  visibility: string;
  title: string;
  artistName: string | null;
  imageKeys: string[];
  acquiredAt: Date;
}): GalleryItem {
  return {
    ownerId: row.ownerId,
    lotId: row.lotId,
    source: row.source as GalleryItem['source'],
    visibility: row.visibility as GalleryItem['visibility'],
    title: row.title,
    artistName: row.artistName,
    imageKeys: row.imageKeys,
    acquiredAt: row.acquiredAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lee el JSONB guardado; un documento que no tiene la forma esperada se ignora y se vuelve a pedir. */
function toSheet(value: unknown): PurchasedSheet | null {
  if (!isRecord(value) || typeof value['lot'] !== 'string' || typeof value['acquiredAt'] !== 'string') {
    return null;
  }
  return {
    lot: value['lot'],
    pricePaid: typeof value['pricePaid'] === 'string' ? value['pricePaid'] : null,
    buyNow: typeof value['buyNow'] === 'boolean' ? value['buyNow'] : null,
    acquiredAt: new Date(value['acquiredAt']),
  };
}
