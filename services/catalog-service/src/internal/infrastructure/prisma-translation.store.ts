import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { TranslatedTexts, TranslationJob, TranslationSource, TranslationStore } from '../application/ports';

/**
 * Huella de los textos de una ficha calculada en Postgres. Es la misma que
 * textHash del dominio: SHA-256 de los cuatro campos separados por chr(31),
 * con la procedencia vacia si no hay. Una prueba compara las dos.
 */
export const TEXT_HASH_SQL = Prisma.sql`encode(sha256(convert_to(l.title || chr(31) || l.description || chr(31) || l.materials || chr(31) || coalesce(l.provenance, ''), 'UTF8')), 'hex')`;

/** Cola de traduccion y traducciones de las fichas en el esquema catalog. */
export class PrismaTranslationStore implements TranslationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueueStale(limit: number): Promise<number> {
    // Fichas publicas cuya version actual no tiene traduccion ni solicitud
    // (pendiente, hecha o fallida). Si ya habia una pendiente de una version
    // anterior, se actualiza a la nueva y vuelve a empezar.
    return this.prisma.$executeRaw`
      INSERT INTO catalog.translation_requests (lot_id, source_hash)
      SELECT current.id, current.hash
      FROM (SELECT l.id, ${TEXT_HASH_SQL} AS hash FROM catalog.lots l WHERE l.visibility = 'PUBLIC') AS current
      WHERE NOT EXISTS (SELECT 1 FROM catalog.lot_translations t WHERE t.lot_id = current.id AND t.source_hash = current.hash)
        AND NOT EXISTS (SELECT 1 FROM catalog.translation_requests r WHERE r.lot_id = current.id AND r.source_hash = current.hash)
      LIMIT ${limit}
      ON CONFLICT (lot_id) WHERE status = 'PENDIENTE'
      DO UPDATE SET source_hash = EXCLUDED.source_hash, attempts = 0, available_at = now(), lease_until = NULL, last_error = NULL`;
  }

  async claimNext(leaseMs: number): Promise<TranslationJob | null> {
    const rows = await this.prisma.$queryRaw<TranslationJob[]>`
      UPDATE catalog.translation_requests
      SET lease_until = now() + ${leaseMs} * interval '1 millisecond', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM catalog.translation_requests
        WHERE status = 'PENDIENTE' AND available_at <= now() AND (lease_until IS NULL OR lease_until < now())
        ORDER BY available_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id::text AS id, lot_id::text AS "lotId", source_hash AS "sourceHash", attempts`;
    return rows[0] ?? null;
  }

  async sourceOf(lotId: string): Promise<TranslationSource | null> {
    const lot = await this.prisma.lot.findUnique({
      where: { id: lotId },
      select: { title: true, description: true, materials: true, provenance: true, visibility: true },
    });
    if (!lot) {
      return null;
    }
    return {
      texts: { title: lot.title, description: lot.description, materials: lot.materials, provenance: lot.provenance },
      visibility: lot.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    };
  }

  async save(job: TranslationJob, sourceHash: string, result: TranslatedTexts): Promise<void> {
    await this.prisma.$transaction([
      // Solo quedan las traducciones de esta version: si la ficha cambio de idioma, las viejas sobran.
      this.prisma.lotTranslation.deleteMany({ where: { lotId: job.lotId } }),
      this.prisma.lotTranslation.createMany({
        data: result.translations.map((translation) => ({
          lotId: job.lotId,
          locale: translation.locale,
          title: translation.texts.title,
          description: translation.texts.description,
          materials: translation.texts.materials,
          provenance: translation.texts.provenance,
          sourceHash,
          model: result.model,
        })),
      }),
      this.prisma.lot.update({ where: { id: job.lotId }, data: { sourceLocale: result.sourceLocale } }),
      this.prisma.translationRequest.update({
        where: { id: job.id },
        data: { status: 'COMPLETADA', completedAt: new Date(), leaseUntil: null, lastError: null },
      }),
    ]);
  }

  async discard(jobId: string): Promise<void> {
    // Se borra en vez de cerrarse: si la ficha vuelve a ser publica con el
    // mismo texto, el reconciliador tiene que poder encolarla otra vez.
    await this.prisma.translationRequest.deleteMany({ where: { id: jobId } });
  }

  async fail(jobId: string, error: string, retryAt: Date | null): Promise<void> {
    await this.prisma.translationRequest.update({
      where: { id: jobId },
      data: retryAt
        ? { availableAt: retryAt, leaseUntil: null, lastError: error }
        : { status: 'FALLIDA', completedAt: new Date(), leaseUntil: null, lastError: error },
    });
  }
}
