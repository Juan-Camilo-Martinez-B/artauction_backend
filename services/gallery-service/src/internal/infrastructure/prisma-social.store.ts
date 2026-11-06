import { isRecord } from '@artauction/platform';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Activity, GalleryItem, PublicGallery, PurchasedSheet } from '../domain/gallery';
import type { PublicGalleryQuery, SocialStore } from '../application/ports';

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

  async updateItem(ownerId: string, lotId: string, patch: Partial<Pick<GalleryItem, 'source' | 'visibility' | 'previewUrl'>>): Promise<void> {
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

  async removeActivity(id: string): Promise<void> {
    await this.prisma.activity.deleteMany({ where: { id } });
  }

  async publicGalleries(query: PublicGalleryQuery): Promise<{ galleries: PublicGallery[]; total: number }> {
    const owner = query.ownerId ? Prisma.sql`AND i.owner_id = ${query.ownerId}::uuid` : Prisma.empty;
    // Se expone lo publico y colgado de una galeria publica: la misma regla de exhibitedItems.
    const exhibited = Prisma.sql`
        FROM gallery.items i
        JOIN gallery.personal_galleries g ON g.owner_id = i.owner_id AND g.visibility = 'PUBLIC'
        JOIN gallery.personal_gallery_artworks a ON a.gallery_id = g.id AND a.lot_id = i.lot_id
        WHERE i.visibility = 'PUBLIC' ${owner}`;
    const order = query.sort === 'POPULAR' ? Prisma.sql`"followerCount" DESC, "latestAt" DESC` : Prisma.sql`"latestAt" DESC`;
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<Array<{ ownerId: string; workCount: number; followerCount: number; latestAt: Date }>>`
        SELECT i.owner_id::text AS "ownerId",
               count(*)::int AS "workCount",
               max(i.acquired_at) AS "latestAt",
               (SELECT count(*)::int FROM gallery.follows f WHERE f.followee_id = i.owner_id) AS "followerCount"
        ${exhibited}
        GROUP BY i.owner_id
        ORDER BY ${order}, i.owner_id
        LIMIT ${query.limit} OFFSET ${query.offset}`,
      this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT count(DISTINCT i.owner_id)::int AS total ${exhibited}`,
    ]);
    const ownerIds = rows.map((row) => row.ownerId);
    const [items, rooms] = await Promise.all([
      this.prisma.galleryItem.findMany({ where: { ownerId: { in: ownerIds }, visibility: 'PUBLIC' }, orderBy: { acquiredAt: 'desc' } }),
      this.prisma.personalGallery.findMany({ where: { ownerId: { in: ownerIds } }, select: { ownerId: true, artworks: { select: { lotId: true } } } }),
    ]);
    const hung = new Map(rooms.map((room) => [room.ownerId, new Set(room.artworks.map((artwork) => artwork.lotId))]));
    return {
      galleries: rows.map((row) => ({
        ...row,
        previews: items
          .filter((item) => item.ownerId === row.ownerId && hung.get(row.ownerId)?.has(item.lotId))
          .slice(0, query.previews)
          .map(toItem),
      })),
      total: totals[0]?.total ?? 0,
    };
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
  previewUrl: string | null;
}): GalleryItem {
  return {
    ownerId: row.ownerId,
    lotId: row.lotId,
    source: row.source as GalleryItem['source'],
    visibility: row.visibility as GalleryItem['visibility'],
    title: row.title,
    artistName: row.artistName,
    imageKeys: row.imageKeys,
    previewUrl: row.previewUrl,
    acquiredAt: row.acquiredAt,
  };
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
