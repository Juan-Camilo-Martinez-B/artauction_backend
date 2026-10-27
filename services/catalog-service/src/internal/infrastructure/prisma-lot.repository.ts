import { appendToOutbox, recordInbox, type DomainEvent, type SqlExecutor } from '@artauction/platform';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { Category, Lot, LotImage, NewLot, RepresentationKind } from '../domain/lot';
import { isLotStatus, PUBLIC_STATUSES, type LotStatus } from '../domain/lot-status';
import type { LotPatch, LotRepository, LotTransitions, PublicLotQuery } from '../application/ports';

export const CATALOG_SCHEMA = 'catalog';

const lotInclude = {
  images: { orderBy: { position: 'asc' } },
  categories: { include: { category: true } },
} satisfies Prisma.LotInclude;

type LotRow = Prisma.LotGetPayload<{ include: typeof lotInclude }>;
type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sqlExecutor(client: Tx | PrismaClient): SqlExecutor {
  return {
    query: <T>(sql: string, ...params: unknown[]) => client.$queryRawUnsafe<T[]>(sql, ...params),
    execute: (sql: string, ...params: unknown[]) => client.$executeRawUnsafe(sql, ...params),
  };
}

export class PrismaLotRepository implements LotRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listPublic(query: PublicLotQuery): Promise<{ lots: Lot[]; total: number }> {
    const where: Prisma.LotWhereInput = { visibility: 'PUBLIC', status: { in: [...PUBLIC_STATUSES] } };
    if (query.text) {
      where.OR = [
        { title: { contains: query.text, mode: 'insensitive' } },
        { artistName: { contains: query.text, mode: 'insensitive' } },
        { materials: { contains: query.text, mode: 'insensitive' } },
        { description: { contains: query.text, mode: 'insensitive' } },
      ];
    }
    if (query.representation) {
      where.representationKind = query.representation;
    }
    if (query.categorySlug) {
      where.categories = { some: { category: { slug: query.categorySlug, active: true } } };
    }
    const orderBy: Prisma.LotOrderByWithRelationInput[] =
      query.sort === 'title'
        ? [{ title: 'asc' }, { id: 'asc' }]
        : query.sort === 'score'
          ? [{ authenticityScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]
          : [{ createdAt: 'desc' }, { id: 'asc' }];
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.lot.count({ where }),
      this.prisma.lot.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: lotInclude,
      }),
    ]);
    return { lots: rows.map(toLot), total };
  }

  async relatedPublic(lotId: string, limit: number): Promise<Lot[]> {
    if (!UUID.test(lotId)) {
      return [];
    }
    const primary = await this.prisma.lotCategory.findFirst({ where: { lotId, isPrimary: true } });
    if (!primary) {
      return [];
    }
    const rows = await this.prisma.lot.findMany({
      where: {
        id: { not: lotId },
        visibility: 'PUBLIC',
        status: { in: [...PUBLIC_STATUSES] },
        categories: { some: { categoryId: primary.categoryId } },
      },
      take: limit,
      orderBy: [{ authenticityScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      include: lotInclude,
    });
    return rows.map(toLot);
  }

  async findById(lotId: string): Promise<Lot | null> {
    if (!UUID.test(lotId)) {
      return null;
    }
    const row = await this.prisma.lot.findUnique({ where: { id: lotId }, include: lotInclude });
    return row ? toLot(row) : null;
  }

  async findByIds(lotIds: readonly string[]): Promise<Lot[]> {
    const ids = lotIds.filter((id) => UUID.test(id));
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.lot.findMany({ where: { id: { in: ids } }, include: lotInclude });
    return rows.map(toLot);
  }

  async findActiveCategory(slug: string): Promise<Category | null> {
    const row = await this.prisma.category.findFirst({ where: { slug, active: true } });
    return row ? toCategory(row) : null;
  }

  async listActiveCategories(): Promise<Category[]> {
    const rows = await this.prisma.category.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    return rows.map(toCategory);
  }

  create(sellerId: string, lot: NewLot, categoryId: string, events: (lot: Lot) => DomainEvent[]): Promise<Lot> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.lot.create({
        data: {
          sellerId,
          title: lot.title,
          description: lot.description,
          artistName: lot.artistName,
          creationYear: lot.creationYear,
          materials: lot.materials,
          representationKind: lot.representationKind,
          widthCm: lot.widthCm,
          heightCm: lot.heightCm,
          depthCm: lot.depthCm,
          provenance: lot.provenance,
          status: 'BORRADOR',
          visibility: 'PRIVATE',
          categories: { create: { categoryId, isPrimary: true } },
        },
        include: lotInclude,
      });
      const created = toLot(row);
      await appendToOutbox(sqlExecutor(tx), CATALOG_SCHEMA, events(created));
      return created;
    });
  }

  async upsertImage(lotId: string, image: { objectKey: string; position: number; perceptualHash: string | null }): Promise<LotImage> {
    const row = await this.prisma.lotImage.upsert({
      where: { lotId_position: { lotId, position: image.position } },
      update: { objectKey: image.objectKey, perceptualHash: image.perceptualHash },
      create: { lotId, objectKey: image.objectKey, position: image.position, perceptualHash: image.perceptualHash },
    });
    return toImage(row);
  }

  transition(lotId: string, from: LotStatus, to: LotStatus, patch: LotPatch, events: (lot: Lot) => DomainEvent[]): Promise<Lot | null> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.lot.updateMany({ where: { id: lotId, status: from }, data: { ...patch, status: to } });
      if (changed.count !== 1) {
        return null;
      }
      const row = await tx.lot.findUniqueOrThrow({ where: { id: lotId }, include: lotInclude });
      const updated = toLot(row);
      await appendToOutbox(sqlExecutor(tx), CATALOG_SCHEMA, events(updated));
      return updated;
    });
  }

  applyOnce(eventId: string, eventType: string, apply: (lots: LotTransitions) => Promise<void>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await recordInbox(sqlExecutor(tx), CATALOG_SCHEMA, eventId, eventType))) {
        return false;
      }
      await apply(transitionsIn(tx));
      return true;
    });
  }
}

function transitionsIn(tx: Tx): LotTransitions {
  return {
    async findById(lotId: string): Promise<Lot | null> {
      if (!UUID.test(lotId)) {
        return null;
      }
      const row = await tx.lot.findUnique({ where: { id: lotId }, include: lotInclude });
      return row ? toLot(row) : null;
    },
    async update(lotId: string, from: readonly LotStatus[], to: LotStatus, patch: LotPatch): Promise<boolean> {
      if (!UUID.test(lotId)) {
        return false;
      }
      const changed = await tx.lot.updateMany({ where: { id: lotId, status: { in: [...from] } }, data: { ...patch, status: to } });
      return changed.count === 1;
    },
  };
}

function decimal(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

function toRepresentation(value: string | null): RepresentationKind | null {
  return value === 'TWO_D' || value === 'THREE_D' || value === 'OTHER' ? value : null;
}

function toCategory(row: { id: string; name: string; slug: string; description: string; active: boolean }): Category {
  return { id: row.id, name: row.name, slug: row.slug, description: row.description, active: row.active };
}

function toImage(row: { id: string; objectKey: string; position: number; perceptualHash: string | null; createdAt: Date }): LotImage {
  return {
    id: row.id,
    objectKey: row.objectKey,
    position: row.position,
    perceptualHash: row.perceptualHash,
    createdAt: row.createdAt,
  };
}

function toLot(row: LotRow): Lot {
  if (!isLotStatus(row.status)) {
    throw new Error(`Estado desconocido en catalog.lots: ${row.status}`);
  }
  return {
    id: row.id,
    sellerId: row.sellerId,
    title: row.title,
    description: row.description,
    artistName: row.artistName,
    creationYear: row.creationYear,
    materials: row.materials,
    widthCm: decimal(row.widthCm),
    heightCm: decimal(row.heightCm),
    depthCm: decimal(row.depthCm),
    provenance: row.provenance,
    representationKind: toRepresentation(row.representationKind),
    status: row.status,
    visibility: row.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    authenticityScore: row.authenticityScore,
    suggestedPriceMin: decimal(row.suggestedPriceMin),
    suggestedPriceMax: decimal(row.suggestedPriceMax),
    currency: row.currency,
    createdAt: row.createdAt,
    images: row.images.map(toImage),
    categories: row.categories.map((link) => ({ isPrimary: link.isPrimary, category: toCategory(link.category) })),
  };
}
