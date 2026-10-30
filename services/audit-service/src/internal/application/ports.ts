import type { DomainEvent } from '@artauction/platform';
import type { Dossier, Finding, ImageMetrics, LotSheet, SimilarImageMatch } from '../domain/dossier';
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

/** Resumen con lo necesario para leer su informe completo (misma llave). */
export interface ReviewSummary {
  summaryId: string;
  lotId: string;
  score: number;
  decidedBy: DecidedBy | null;
  modelName: string;
  createdAt: Date;
}

/** Hallazgo con el valor de cada evidencia que cita. */
export interface ReviewFinding {
  code: string;
  severity: Finding['severity'];
  message: string;
  evidence: Array<{ code: string; value: string }>;
}

export interface CompletedAudit {
  summaryId: string;
  lotId: string;
  verdict: Verdict;
  assessment: Assessment;
  decidedBy: DecidedBy;
  /** Expediente del informe completo; null si no se pudo armar. */
  dossier: Dossier | null;
  event: DomainEvent;
}

export interface AuditRepository {
  /** Registra el evento en el inbox y crea la solicitud en la misma transaccion. */
  enqueueOnce(eventId: string, lotId: string): Promise<boolean>;
  /** Toma solicitudes vencidas con FOR UPDATE SKIP LOCKED y les pone un lease. */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<AuditRequest[]>;
  /** Guarda el resumen, su informe completo y el evento del outbox, y cierra la solicitud: todo en una transaccion. */
  complete(requestId: string, audit: CompletedAudit): Promise<void>;
  /** La obra ya no espera auditoria: cierra la solicitud sin emitir nada. */
  skip(requestId: string, reason: string): Promise<void>;
  retryLater(requestId: string, attempts: number, availableAt: Date, error: string): Promise<void>;
  cachedAssessment(dossierHash: string): Promise<Assessment | null>;
  saveAssessment(dossierHash: string, assessment: Assessment): Promise<void>;
  latestSummaries(lotIds: readonly string[]): Promise<AuditSummary[]>;
  latestForReview(lotIds: readonly string[]): Promise<ReviewSummary[]>;
}

/** Lectura de los informes completos para quien revisa a mano. */
export interface ReportStore {
  /** Hallazgos del informe de cada resumen, con sus evidencias resueltas. */
  findings(summaryIds: readonly string[]): Promise<Map<string, ReviewFinding[]>>;
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
