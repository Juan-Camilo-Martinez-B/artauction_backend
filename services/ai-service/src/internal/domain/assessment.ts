// Evaluacion de una obra a partir de su expediente de evidencias. El modelo
// nunca ve imagenes: razona sobre datos ya medidos por audit-service, y todo lo
// que devuelve se sanea aqui antes de salir del servicio.

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** Codigos del expediente que sostienen el hallazgo. */
  evidence: string[];
}

export interface EvidenceItem {
  code: string;
  value: string;
}

export interface ArtworkDossier {
  lotId: string;
  title: string;
  description: string;
  materials: string;
  creationYear: number | null;
  artistName: string | null;
  declaredDimensions: string;
  provenance: string;
  evidence: EvidenceItem[];
  ruleFindings: Finding[];
}

export interface Assessment {
  model: string;
  promptVersion: string;
  score: number;
  critical: boolean;
  priceMin: number;
  priceMax: number;
  findings: Finding[];
}

// v3: el modelo debe proponer un precio mayor que 0 (F17).
export const PROMPT_VERSION = 'v3';
export const LOCAL_MODEL = 'local-rules';

const MAX_FINDINGS = 8;
const MAX_MESSAGE_LENGTH = 280;
const MAX_PRICE = 10_000_000;
/** Precio minimo de un rango util, en artacoins: con 0 la subasta abriria sin valor. */
const MIN_PRICE = 1;
const FINDING_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function clampScore(score: number): number {
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
}

export function normalizePriceBand(min: number, max: number): { priceMin: number; priceMax: number } {
  const clamp = (value: number) => Math.max(0, Math.min(MAX_PRICE, Math.round(Number.isFinite(value) ? value : 0)));
  const left = clamp(min);
  const right = clamp(max);
  return { priceMin: Math.min(left, right), priceMax: Math.max(left, right) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function severityOf(value: unknown): Severity {
  return value === 'CRITICAL' || value === 'WARNING' ? value : 'INFO';
}

function evidenceCodes(dossier: ArtworkDossier): Set<string> {
  return new Set(dossier.evidence.map((item) => item.code));
}

/**
 * Convierte la respuesta del modelo en una evaluacion confiable:
 * - acota score y precios;
 * - descarta hallazgos sin evidencia o con evidencia inventada (codigos que no
 *   estan en el expediente), asi cada argumento queda verificable;
 * - un hallazgo critico de las reglas deterministas siempre prevalece, aunque
 *   el texto del vendedor intente convencer al modelo de lo contrario.
 */
export function sanitizeAssessment(raw: unknown, dossier: ArtworkDossier, model: string): Assessment {
  if (!isRecord(raw)) {
    throw new Error('La respuesta del modelo no es un objeto JSON');
  }
  const known = evidenceCodes(dossier);
  const findings: Finding[] = [];
  for (const item of Array.isArray(raw['findings']) ? raw['findings'] : []) {
    if (!isRecord(item) || findings.length >= MAX_FINDINGS) {
      continue;
    }
    const code = typeof item['code'] === 'string' ? item['code'].trim().toUpperCase() : '';
    const message = typeof item['message'] === 'string' ? item['message'].trim().slice(0, MAX_MESSAGE_LENGTH) : '';
    const cited = Array.isArray(item['evidence']) ? item['evidence'].filter((ref): ref is string => typeof ref === 'string') : [];
    const evidence = [...new Set(cited)].filter((ref) => known.has(ref));
    if (!FINDING_CODE.test(code) || message.length === 0 || evidence.length === 0) {
      continue;
    }
    findings.push({ code, severity: severityOf(item['severity']), message, evidence });
  }
  const ruleCritical = dossier.ruleFindings.some((finding) => finding.severity === 'CRITICAL');
  const modelCritical = raw['critical'] === true || findings.some((finding) => finding.severity === 'CRITICAL');
  // Un rango que empieza en 0 no sirve para abrir una subasta: si el modelo no
  // da un precio, la evaluacion conserva su score y sus hallazgos y toma el
  // rango de la evaluacion local.
  const proposed = normalizePriceBand(Number(raw['priceMin']), Number(raw['priceMax']));
  const band = proposed.priceMin >= MIN_PRICE ? proposed : localPriceBand(dossier);
  return {
    model,
    promptVersion: PROMPT_VERSION,
    score: clampScore(Number(raw['score'])),
    critical: ruleCritical || modelCritical,
    priceMin: band.priceMin,
    priceMax: band.priceMax,
    findings,
  };
}

/** Precio mas bajo que propone la evaluacion local, en artacoins. */
const LOCAL_PRICE_FLOOR = 50;

/**
 * Rango de precio de la evaluacion local: 400 artacoins menos 60 por cada
 * advertencia de las reglas (50 si hay una critica), y el doble como maximo.
 * Nunca baja de LOCAL_PRICE_FLOOR, aunque haya muchas advertencias.
 */
export function localPriceBand(dossier: ArtworkDossier): { priceMin: number; priceMax: number } {
  const warnings = dossier.ruleFindings.filter((finding) => finding.severity === 'WARNING').length;
  const critical = dossier.ruleFindings.some((finding) => finding.severity === 'CRITICAL');
  const base = Math.max(LOCAL_PRICE_FLOOR, critical ? LOCAL_PRICE_FLOOR : 400 - warnings * 60);
  return normalizePriceBand(base, base * 2);
}

/**
 * Evaluacion determinista sin modelo: parte de 85 y descuenta por cada
 * hallazgo de las reglas. Sirve en local y en pruebas; con las mismas
 * evidencias siempre da el mismo resultado.
 */
export function localAssessment(dossier: ArtworkDossier): Assessment {
  const warnings = dossier.ruleFindings.filter((finding) => finding.severity === 'WARNING').length;
  const critical = dossier.ruleFindings.some((finding) => finding.severity === 'CRITICAL');
  const score = clampScore(critical ? 28 : 85 - warnings * 12);
  const band = localPriceBand(dossier);
  return {
    model: LOCAL_MODEL,
    promptVersion: PROMPT_VERSION,
    score,
    critical,
    priceMin: band.priceMin,
    priceMax: band.priceMax,
    findings: dossier.ruleFindings.map((finding) => ({ ...finding })),
  };
}
