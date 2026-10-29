import type { DomainEvent } from '@artauction/platform';
import type { Finding } from './dossier';

export type Verdict = 'APROBADO' | 'REVISION_MANUAL';
/** Quien tomo la decision: reglas deterministas, la IA o el respaldo tras agotar reintentos. */
export type DecidedBy = 'RULES' | 'AI' | 'FALLBACK';

export interface Assessment {
  model: string;
  promptVersion: string;
  score: number;
  critical: boolean;
  priceMin: number;
  priceMax: number;
  findings: Finding[];
}

export const MIN_APPROVED_SCORE = 40;
export const MAX_ATTEMPTS = 5;
const BASE_RETRY_MS = 10_000;
const MAX_RETRY_MS = 300_000;

export const AUDIT_EVENTS = {
  completed: 'audit.AuditCompleted',
} as const;

export function decideVerdict(score: number, critical: boolean): Verdict {
  return critical || score < MIN_APPROVED_SCORE ? 'REVISION_MANUAL' : 'APROBADO';
}

/** Backoff exponencial del worker: 10 s, 20 s, 40 s... hasta 5 minutos. */
export function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1)));
}

/**
 * Evaluacion sin IA cuando una regla critica ya decide: no se gastan tokens y
 * la obra va a revision manual con los hallazgos de las reglas como argumento.
 */
export function rulesAssessment(ruleFindings: readonly Finding[]): Assessment {
  return {
    model: 'rules',
    promptVersion: 'none',
    score: 0,
    critical: true,
    priceMin: 0,
    priceMax: 0,
    findings: [...ruleFindings],
  };
}

/** Respaldo cuando la IA no respondio tras todos los intentos. */
export function fallbackAssessment(ruleFindings: readonly Finding[]): Assessment {
  return {
    model: 'fallback',
    promptVersion: 'none',
    score: 0,
    critical: false,
    priceMin: 0,
    priceMax: 0,
    findings: [
      ...ruleFindings,
      { code: 'AI_UNAVAILABLE', severity: 'WARNING', message: 'La auditoria automatica no pudo completarse; requiere revision manual.', evidence: [] },
    ],
  };
}

export function rationale(findings: readonly Finding[]): string {
  return findings.map((finding) => finding.message).join(' ').slice(0, 1_000);
}

export function auditCompleted(input: {
  lotId: string;
  sellerId: string;
  title: string;
  verdict: Verdict;
  assessment: Assessment;
}): DomainEvent {
  return {
    type: AUDIT_EVENTS.completed,
    aggregateId: input.lotId,
    payload: {
      lotId: input.lotId,
      sellerId: input.sellerId,
      title: input.title,
      verdict: input.verdict,
      score: input.assessment.score,
      priceMin: input.assessment.priceMin,
      priceMax: input.assessment.priceMax,
      critical: input.assessment.critical,
      rationale: rationale(input.assessment.findings),
    },
  };
}
