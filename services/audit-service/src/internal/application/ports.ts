import type { DomainEvent } from '@artauction/platform';
import type { Dossier, ImageMetrics, LotSheet, SimilarImageMatch } from '../domain/dossier';
import type { Assessment, DecidedBy, Verdict } from '../domain/verdict';

export interface AuditRequest {
  id: string;
  lotId: string;
  attempts: number;
}

export interface AuditSummary {
  id: string;
  lotId: string;
  score: number;
  priceMin: number;
  priceMax: number;
  verdict: Verdict;
  critical: boolean;
  modelName: string;
  promptVersion: string;
  createdAt: Date;
}

export interface CompletedAudit {
  summaryId: string;
  lotId: string;
  verdict: Verdict;
  assessment: Assessment;
  decidedBy: DecidedBy;
  dossierHash: string | null;
  reportId: string;
  event: DomainEvent;
}

export interface AuditRepository {
  /** Registra el evento en el inbox y crea la solicitud en la misma transaccion. */
  enqueueOnce(eventId: string, lotId: string): Promise<boolean>;
  /** Toma solicitudes vencidas con FOR UPDATE SKIP LOCKED y les pone un lease. */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<AuditRequest[]>;
  /** Guarda el resumen, el evento del outbox y cierra la solicitud, todo junto. */
  complete(requestId: string, audit: CompletedAudit): Promise<void>;
  /** La obra ya no espera auditoria: cierra la solicitud sin emitir nada. */
  skip(requestId: string, reason: string): Promise<void>;
  retryLater(requestId: string, attempts: number, availableAt: Date, error: string): Promise<void>;
  cachedAssessment(dossierHash: string): Promise<Assessment | null>;
  saveAssessment(dossierHash: string, assessment: Assessment): Promise<void>;
  latestSummaries(lotIds: readonly string[]): Promise<AuditSummary[]>;
}

/** Informe completo (expediente y respuesta) para quien revisa a mano. */
export interface AuditReport {
  id: string;
  lotId: string;
  decidedBy: DecidedBy;
  dossier: Dossier | null;
  assessment: Assessment;
  createdAt: Date;
}

export interface ReportStore {
  /** Idempotente por id: un reintento no duplica el informe. */
  save(report: AuditReport): Promise<void>;
}

export interface CatalogPort {
  lot(lotId: string): Promise<LotSheet | null>;
  similarImages(lotId: string, hashes: readonly string[]): Promise<SimilarImageMatch[]>;
}

export interface ImageAnalyzer {
  /** Mide la imagen; null si no se pudo descargar o no es una imagen valida. */
  analyze(url: string): Promise<ImageMetrics | null>;
}

export interface AiPort {
  audit(dossier: Dossier): Promise<Assessment>;
}

export interface Clock {
  now(): Date;
}
