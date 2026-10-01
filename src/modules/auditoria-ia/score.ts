export interface Finding {
  code: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
}

export interface AuditResult {
  model: string;
  promptVersion: string;
  score: number;
  critical: boolean;
  priceMin: number;
  priceMax: number;
  findings: Finding[];
}

export type AuditVerdict = 'APROBADO' | 'REVISION_MANUAL';

export function decideVerdict(score: number, critical: boolean): AuditVerdict {
  if (critical || score < 40) {
    return 'REVISION_MANUAL';
  }
  return 'APROBADO';
}

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function normalizePriceBand(min: number, max: number): { priceMin: number; priceMax: number } {
  const left = Math.max(0, Math.round(Number.isFinite(min) ? min : 0));
  const right = Math.max(0, Math.round(Number.isFinite(max) ? max : 0));
  return { priceMin: Math.min(left, right), priceMax: Math.max(left, right) };
}
