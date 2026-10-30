import { randomUUID } from 'node:crypto';
import { DomainError, type StructuredLogger } from '@artauction/platform';
import { buildDossier, MAX_IMAGES, type Dossier, type LotSheet } from '../domain/dossier';
import {
  auditCompleted,
  decideVerdict,
  fallbackAssessment,
  MAX_ATTEMPTS,
  nextAttemptAt,
  rulesAssessment,
  type Assessment,
  type DecidedBy,
} from '../domain/verdict';
import type { AiPort, AuditRepository, AuditRequest, AuditSummary, CatalogPort, Clock, ImageAnalyzer, ReportStore, ReviewFinding, ReviewSummary } from './ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_AUDIT = 'PENDIENTE_AUDITORIA';
const LOCAL_MODEL = 'local-rules';
const LEASE_MS = 120_000;

/** LotSubmitted: encola la auditoria una sola vez por evento. */
export class EnqueueAudit {
  constructor(private readonly audits: AuditRepository) {}

  execute(event: { eventId: string; lotId: string }): Promise<boolean> {
    if (!event.eventId || !UUID.test(event.lotId)) {
      throw DomainError.invalid('LotSubmitted sin event_id o con lot_id invalido');
    }
    return this.audits.enqueueOnce(event.eventId, event.lotId);
  }
}

export interface AuditDependencies {
  audits: AuditRepository;
  catalog: CatalogPort;
  images: ImageAnalyzer;
  ai: AiPort;
  clock: Clock;
  logger: StructuredLogger;
}

/**
 * Procesa las solicitudes vencidas. Por cada obra arma el expediente, decide
 * sin IA si una regla critica ya basta (cortocircuito), reutiliza una
 * evaluacion previa del mismo expediente (cache) o consulta a ai-service.
 * Un fallo se reintenta con backoff; al agotar los intentos la obra va a
 * revision manual con un veredicto de respaldo.
 */
export class RunAuditWorker {
  constructor(private readonly deps: AuditDependencies) {}

  async tick(limit = 5): Promise<number> {
    const due = await this.deps.audits.claimDue(this.deps.clock.now(), LEASE_MS, limit);
    for (const request of due) {
      await this.process(request);
    }
    return due.length;
  }

  private async process(request: AuditRequest): Promise<void> {
    const attempt = request.attempts + 1;
    try {
      const lot = await this.deps.catalog.lot(request.lotId);
      if (!lot || lot.status !== PENDING_AUDIT) {
        await this.deps.audits.skip(request.id, lot ? `estado ${lot.status}` : 'obra inexistente');
        return;
      }
      const dossier = await this.dossierFor(lot);
      const decided = await this.decide(dossier);
      await this.finish(request, lot, decided.assessment, decided.decidedBy, dossier);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_ATTEMPTS) {
        this.deps.logger.warn(`auditoria de ${request.lotId} fallo (intento ${String(attempt)}): ${message}`, 'audit-worker');
        await this.deps.audits.retryLater(request.id, attempt, nextAttemptAt(this.deps.clock.now(), attempt), message);
        return;
      }
      this.deps.logger.error(`auditoria de ${request.lotId} agoto los intentos: ${message}`, undefined, 'audit-worker');
      const lot = await this.deps.catalog.lot(request.lotId).catch(() => null);
      if (!lot || lot.status !== PENDING_AUDIT) {
        await this.deps.audits.skip(request.id, 'sin ficha tras agotar los intentos');
        return;
      }
      await this.finish(request, lot, fallbackAssessment([]), 'FALLBACK', null);
    }
  }

  private async dossierFor(lot: LotSheet): Promise<Dossier> {
    const urls = lot.images.slice(0, MAX_IMAGES).map((image) => image.url);
    const images = await Promise.all(urls.map((url) => (url ? this.deps.images.analyze(url) : Promise.resolve(null))));
    const hashes = lot.images.flatMap((image) => (image.perceptualHash ? [image.perceptualHash] : []));
    const similar = hashes.length === 0 ? [] : await this.deps.catalog.similarImages(lot.lotId, hashes);
    return buildDossier(lot, images, similar);
  }

  private async decide(dossier: Dossier): Promise<{ assessment: Assessment; decidedBy: DecidedBy }> {
    if (dossier.ruleFindings.some((finding) => finding.severity === 'CRITICAL')) {
      return { assessment: rulesAssessment(dossier.ruleFindings), decidedBy: 'RULES' };
    }
    const cached = await this.deps.audits.cachedAssessment(dossier.hash);
    if (cached) {
      return { assessment: cached, decidedBy: 'AI' };
    }
    const assessment = await this.deps.ai.audit(dossier);
    // La evaluacion local no se cachea: con una clave de Gemini posterior, la
    // misma obra debe recibir la opinion del modelo.
    if (assessment.model !== LOCAL_MODEL) {
      await this.deps.audits.saveAssessment(dossier.hash, assessment);
    }
    return { assessment, decidedBy: 'AI' };
  }

  private async finish(request: AuditRequest, lot: LotSheet, assessment: Assessment, decidedBy: DecidedBy, dossier: Dossier | null): Promise<void> {
    const summaryId = randomUUID();
    const verdict = decidedBy === 'FALLBACK' ? 'REVISION_MANUAL' : decideVerdict(assessment.score, assessment.critical);
    // Resumen, informe completo y evento entran en una sola transaccion: si
    // falla, el reintento empieza de cero y no queda un informe sin resumen.
    await this.deps.audits.complete(request.id, {
      summaryId,
      lotId: lot.lotId,
      verdict,
      assessment,
      decidedBy,
      dossier,
      event: auditCompleted({ lotId: lot.lotId, sellerId: lot.sellerId, title: lot.title, verdict, assessment }),
    });
  }
}

/** Ultimo resumen por obra, para que el gateway componga la ficha. */
export class GetLatestSummaries {
  constructor(private readonly audits: AuditRepository) {}

  execute(lotIds: readonly string[]): Promise<AuditSummary[]> {
    const ids = [...new Set(lotIds)].filter((id) => UUID.test(id)).slice(0, 100);
    return ids.length === 0 ? Promise.resolve([]) : this.audits.latestSummaries(ids);
  }
}

export interface ReviewReport extends ReviewSummary {
  findings: ReviewFinding[];
}

/**
 * Expediente de las obras en revision manual, para que un administrador
 * decida con los mismos argumentos que uso la auditoria. Solo ADMIN.
 */
export class GetReviewReports {
  constructor(
    private readonly audits: AuditRepository,
    private readonly reports: ReportStore,
  ) {}

  async execute(actor: { role: string }, lotIds: readonly string[]): Promise<ReviewReport[]> {
    if (actor.role !== 'ADMIN') {
      throw DomainError.forbidden('Solo un administrador ve los expedientes de auditoria');
    }
    const ids = [...new Set(lotIds)].filter((id) => UUID.test(id)).slice(0, 100);
    if (ids.length === 0) {
      return [];
    }
    const summaries = await this.audits.latestForReview(ids);
    const findings = await this.reports.findings(summaries.map((summary) => summary.summaryId));
    return summaries.map((summary) => ({ ...summary, findings: findings.get(summary.summaryId) ?? [] }));
  }
}
