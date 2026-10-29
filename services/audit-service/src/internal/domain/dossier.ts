import { createHash } from 'node:crypto';

// Expediente de evidencias de una obra. Todo lo que aqui se mide lo calcula el
// sistema (no la IA): la IA solo razona sobre este resumen, asi el costo en
// tokens es acotado y cada argumento de la decision queda verificable.

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  evidence: string[];
}

export interface EvidenceItem {
  code: string;
  value: string;
}

/** Ficha de la obra tal como la entrega catalog. */
export interface LotSheet {
  lotId: string;
  sellerId: string;
  status: string;
  title: string;
  description: string;
  artistName: string | null;
  creationYear: number | null;
  materials: string;
  widthCm: number | null;
  heightCm: number | null;
  provenance: string;
  images: Array<{ url: string | null; perceptualHash: string | null }>;
}

/** Medidas de una imagen descargada; null si no se pudo analizar. */
export interface ImageMetrics {
  width: number;
  height: number;
  format: string;
  bytes: number;
  /** Varianza del Laplaciano en grises: baja indica una imagen borrosa. */
  sharpness: number;
  /** Entropia media de los canales, 0-8 bits. */
  entropy: number;
  /** Saturacion media 0-1. */
  saturation: number;
  dominantColor: string;
  exif: {
    software: string | null;
    camera: string | null;
    takenAt: string | null;
    /** Texto de metadatos que delata un generador de imagenes, si aparece. */
    generatorMarker: string | null;
  };
}

/** Imagen de otra obra casi identica a una de esta. */
export interface SimilarImageMatch {
  lotId: string;
  sellerId: string;
  queryHash: string;
  distance: number;
}

export interface Dossier {
  lot: LotSheet;
  evidence: EvidenceItem[];
  ruleFindings: Finding[];
  hash: string;
}

const MIN_LONG_SIDE_PX = 800;
const ASPECT_TOLERANCE = 0.15;
const BLUR_SHARPNESS = 60;
const MAX_IMAGES = 6;
const GENERATOR_PATTERN = /midjourney|dall[-· ]?e|stable[ -]?diffusion|firefly|leonardo\.ai|novelai|sdxl|comfyui|automatic1111|imagen/i;

/**
 * Materiales con fecha de invencion conocida. Una obra declarada anterior a
 * esa fecha con ese material es una inconsistencia fuerte.
 */
const MATERIAL_SINCE: ReadonlyArray<{ pattern: RegExp; label: string; year: number }> = [
  { pattern: /acr[ií]lic/i, label: 'pintura acrilica', year: 1950 },
  { pattern: /gicl[ée]e/i, label: 'impresion giclee', year: 1990 },
  { pattern: /resina epox|epoxy/i, label: 'resina epoxica', year: 1940 },
  { pattern: /fotograf/i, label: 'fotografia', year: 1839 },
  { pattern: /serigraf/i, label: 'serigrafia artistica', year: 1930 },
  { pattern: /aerosol|spray/i, label: 'pintura en aerosol', year: 1949 },
  { pattern: /impresi[oó]n digital|digital print/i, label: 'impresion digital', year: 1985 },
];

export function generatorMarker(texts: ReadonlyArray<string | null | undefined>): string | null {
  for (const text of texts) {
    const found = text ? GENERATOR_PATTERN.exec(text) : null;
    if (found) {
      return found[0];
    }
  }
  return null;
}

function round(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

/** Evidencias en formato codigo = valor, con codigos estables por imagen. */
export function buildEvidence(lot: LotSheet, images: ReadonlyArray<ImageMetrics | null>, similar: readonly SimilarImageMatch[]): EvidenceItem[] {
  const evidence: EvidenceItem[] = [
    { code: 'lot.images', value: String(lot.images.length) },
    { code: 'lot.analyzed_images', value: String(images.filter((image) => image !== null).length) },
    { code: 'lot.declared_year', value: lot.creationYear === null ? 'sin dato' : String(lot.creationYear) },
    { code: 'lot.declared_materials', value: lot.materials.slice(0, 120) },
  ];
  if (lot.widthCm !== null && lot.heightCm !== null && lot.heightCm > 0) {
    evidence.push({ code: 'lot.declared_aspect', value: round(lot.widthCm / lot.heightCm, 3) });
  }
  images.slice(0, MAX_IMAGES).forEach((image, index) => {
    const prefix = `img${String(index + 1)}`;
    if (!image) {
      evidence.push({ code: `${prefix}.status`, value: 'no analizada' });
      return;
    }
    evidence.push(
      { code: `${prefix}.size`, value: `${String(image.width)}x${String(image.height)} ${image.format} ${String(Math.round(image.bytes / 1024))}KB` },
      { code: `${prefix}.aspect`, value: round(image.width / image.height, 3) },
      { code: `${prefix}.sharpness`, value: round(image.sharpness, 1) },
      { code: `${prefix}.entropy`, value: round(image.entropy, 2) },
      { code: `${prefix}.saturation`, value: round(image.saturation, 2) },
      { code: `${prefix}.dominant_color`, value: image.dominantColor },
      { code: `${prefix}.exif.software`, value: image.exif.software ?? 'sin dato' },
      { code: `${prefix}.exif.camera`, value: image.exif.camera ?? 'sin dato' },
      { code: `${prefix}.exif.taken_at`, value: image.exif.takenAt ?? 'sin dato' },
    );
    if (image.exif.generatorMarker) {
      evidence.push({ code: `${prefix}.exif.generator`, value: image.exif.generatorMarker });
    }
  });
  similar.slice(0, 5).forEach((match, index) => {
    const owner = match.sellerId === lot.sellerId ? 'mismo vendedor' : 'otro vendedor';
    evidence.push({ code: `catalog.duplicate${String(index + 1)}`, value: `obra ${match.lotId}, ${owner}, distancia ${String(match.distance)}` });
  });
  return evidence;
}

/** Reglas deterministas. Cada hallazgo cita las evidencias que lo sostienen. */
export function applyRules(lot: LotSheet, images: ReadonlyArray<ImageMetrics | null>, similar: readonly SimilarImageMatch[]): Finding[] {
  const findings: Finding[] = [];
  const material = lot.creationYear === null ? undefined : MATERIAL_SINCE.find((entry) => entry.pattern.test(lot.materials));
  if (material && lot.creationYear !== null && lot.creationYear < material.year) {
    findings.push({
      code: 'MATERIAL_ANACHRONISM',
      severity: 'CRITICAL',
      message: `La ${material.label} no existia en ${String(lot.creationYear)} (aparece hacia ${String(material.year)}).`,
      evidence: ['lot.declared_year', 'lot.declared_materials'],
    });
  }
  similar.forEach((match, index) => {
    if (index >= 5) {
      return;
    }
    const code = `catalog.duplicate${String(index + 1)}`;
    findings.push(
      match.sellerId === lot.sellerId
        ? { code: 'DUPLICATE_IMAGE_SAME_SELLER', severity: 'WARNING', message: 'El vendedor reutiliza una imagen de otra de sus obras.', evidence: [code] }
        : { code: 'DUPLICATE_IMAGE_OTHER_SELLER', severity: 'CRITICAL', message: 'Una imagen coincide con la obra de otro vendedor.', evidence: [code] },
    );
  });
  const declaredAspect = lot.widthCm !== null && lot.heightCm !== null && lot.heightCm > 0 ? lot.widthCm / lot.heightCm : null;
  images.slice(0, MAX_IMAGES).forEach((image, index) => {
    if (!image) {
      return;
    }
    const prefix = `img${String(index + 1)}`;
    if (image.exif.generatorMarker) {
      findings.push({
        code: 'AI_GENERATOR_METADATA',
        severity: 'CRITICAL',
        message: `Los metadatos de la imagen ${String(index + 1)} mencionan un generador de imagenes (${image.exif.generatorMarker}).`,
        evidence: [`${prefix}.exif.generator`],
      });
    }
    if (Math.max(image.width, image.height) < MIN_LONG_SIDE_PX) {
      findings.push({ code: 'LOW_RESOLUTION', severity: 'WARNING', message: `La imagen ${String(index + 1)} tiene poca resolucion para verificar detalles.`, evidence: [`${prefix}.size`] });
    }
    if (image.sharpness < BLUR_SHARPNESS) {
      findings.push({ code: 'BLURRY_IMAGE', severity: 'WARNING', message: `La imagen ${String(index + 1)} esta desenfocada.`, evidence: [`${prefix}.sharpness`] });
    }
    if (declaredAspect !== null && index === 0) {
      const actual = image.width / image.height;
      const deviation = Math.min(Math.abs(actual - declaredAspect), Math.abs(1 / actual - declaredAspect)) / declaredAspect;
      if (deviation > ASPECT_TOLERANCE) {
        findings.push({
          code: 'ASPECT_MISMATCH',
          severity: 'WARNING',
          message: 'La proporcion de la imagen principal no coincide con las medidas declaradas.',
          evidence: [`${prefix}.aspect`, 'lot.declared_aspect'],
        });
      }
    }
  });
  if (lot.images.length === 0 || images.every((image) => image === null)) {
    findings.push({ code: 'NO_ANALYZABLE_IMAGES', severity: 'WARNING', message: 'No hay imagenes que se pudieran analizar.', evidence: ['lot.analyzed_images'] });
  }
  return findings;
}

/** Huella estable del expediente: misma obra sin cambios, misma huella. */
export function dossierHash(lot: LotSheet, evidence: readonly EvidenceItem[], findings: readonly Finding[]): string {
  const canonical = JSON.stringify({
    declared: [lot.title, lot.description, lot.artistName, lot.creationYear, lot.materials, lot.widthCm, lot.heightCm, lot.provenance],
    evidence: [...evidence].sort((left, right) => left.code.localeCompare(right.code)).map((item) => [item.code, item.value]),
    findings: findings.map((finding) => [finding.code, finding.severity, finding.evidence]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildDossier(lot: LotSheet, images: ReadonlyArray<ImageMetrics | null>, similar: readonly SimilarImageMatch[]): Dossier {
  const evidence = buildEvidence(lot, images, similar);
  const ruleFindings = applyRules(lot, images, similar);
  return { lot, evidence, ruleFindings, hash: dossierHash(lot, evidence, ruleFindings) };
}

export { MAX_IMAGES };
