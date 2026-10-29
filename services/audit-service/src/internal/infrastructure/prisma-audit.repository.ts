import { appendToOutbox, recordInbox, sqlExecutorFrom } from '@artauction/platform';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Finding } from '../domain/dossier';
import type { Assessment, Verdict } from '../domain/verdict';
import type { AuditRepository, AuditRequest, AuditSummary, CompletedAudit } from '../application/ports';

const AUDIT_SCHEMA = 'audit';
/** Una evaluacion cacheada vale 30 dias; despues se vuelve a consultar al modelo. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isAssessment(value: unknown): value is Assessment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['model'] === 'string' &&
    typeof record['score'] === 'number' &&
    typeof record['critical'] === 'boolean' &&
    Array.isArray(record['findings'])
  );
}

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  enqueueOnce(eventId: string, lotId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await recordInbox(sqlExecutorFrom(tx), AUDIT_SCHEMA, eventId, 'catalog.LotSubmitted'))) {
        return false;
      }
      // Si la obra ya tiene una auditoria pendiente, el indice unico parcial la
      // protege y esta solicitud no se crea.
      await tx.$executeRaw`
        INSERT INTO audit.audit_requests (lot_id, source_event_id)
        VALUES (CAST(${lotId} AS uuid), ${eventId})
        ON CONFLICT DO NOTHING`;
      return true;
    });
  }

  async claimDue(now: Date, leaseMs: number, limit: number): Promise<AuditRequest[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; lot_id: string; attempts: number }>>`
      UPDATE audit.audit_requests
         SET lease_until = ${leaseUntil}
       WHERE id IN (
         SELECT id FROM audit.audit_requests
          WHERE status = 'PENDIENTE'
            AND available_at <= ${now}
            AND (lease_until IS NULL OR lease_until < ${now})
          ORDER BY available_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id, lot_id::text AS lot_id, attempts`;
    return rows.map((row) => ({ id: row.id, lotId: row.lot_id, attempts: row.attempts }));
  }

  async complete(requestId: string, audit: CompletedAudit): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const closed = await tx.auditRequest.updateMany({
        where: { id: requestId, status: 'PENDIENTE' },
        data: { status: 'COMPLETADA', completedAt: new Date(), leaseUntil: null, lastError: null },
      });
      // Otro worker ya la cerro (lease vencido): no se emite un segundo evento.
      if (closed.count !== 1) {
        return;
      }
      await tx.auditSummary.create({
        data: {
          id: audit.summaryId,
          lotId: audit.lotId,
          score: audit.assessment.score,
          priceMin: new Prisma.Decimal(audit.assessment.priceMin),
          priceMax: new Prisma.Decimal(audit.assessment.priceMax),
          verdict: audit.verdict,
          hasCriticalInconsistency: audit.assessment.critical,
          mongoReportId: audit.reportId,
          modelName: audit.assessment.model,
          promptVersion: audit.assessment.promptVersion,
          decidedBy: audit.decidedBy,
          dossierHash: audit.dossierHash,
        },
      });
      await appendToOutbox(sqlExecutorFrom(tx), AUDIT_SCHEMA, [audit.event]);
    });
  }

  async skip(requestId: string, reason: string): Promise<void> {
    await this.prisma.auditRequest.updateMany({
      where: { id: requestId, status: 'PENDIENTE' },
      data: { status: 'COMPLETADA', completedAt: new Date(), leaseUntil: null, lastError: `omitida: ${reason}`.slice(0, 500) },
    });
  }

  async retryLater(requestId: string, attempts: number, availableAt: Date, error: string): Promise<void> {
    await this.prisma.auditRequest.updateMany({
      where: { id: requestId, status: 'PENDIENTE' },
      data: { attempts, availableAt, leaseUntil: null, lastError: error.slice(0, 500) },
    });
  }

  async cachedAssessment(dossierHash: string): Promise<Assessment | null> {
    const row = await this.prisma.aiAssessment.findFirst({
      where: { dossierHash, createdAt: { gte: new Date(Date.now() - CACHE_TTL_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    return row && isAssessment(row.result) ? row.result : null;
  }

  async saveAssessment(dossierHash: string, assessment: Assessment): Promise<void> {
    const result = { ...assessment, findings: assessment.findings.map((finding: Finding) => ({ ...finding })) };
    await this.prisma.aiAssessment.upsert({
      where: { dossierHash_modelName_promptVersion: { dossierHash, modelName: assessment.model, promptVersion: assessment.promptVersion } },
      create: { dossierHash, modelName: assessment.model, promptVersion: assessment.promptVersion, result },
      update: { result, createdAt: new Date() },
    });
  }

  async latestSummaries(lotIds: readonly string[]): Promise<AuditSummary[]> {
    const rows = await this.prisma.auditSummary.findMany({
      where: { lotId: { in: [...lotIds] } },
      orderBy: { createdAt: 'desc' },
      distinct: ['lotId'],
    });
    return rows.map((row) => ({
      id: row.id,
      lotId: row.lotId,
      score: row.score,
      priceMin: row.priceMin.toNumber(),
      priceMax: row.priceMax.toNumber(),
      verdict: row.verdict as Verdict,
      critical: row.hasCriticalInconsistency,
      modelName: row.modelName,
      promptVersion: row.promptVersion,
      createdAt: row.createdAt,
    }));
  }
}
