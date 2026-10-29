import sharp from 'sharp';
import { StructuredLogger, type DomainEvent } from '@artauction/platform';
import { applyRules, buildDossier, generatorMarker, type Dossier, type ImageMetrics, type LotSheet } from '../src/internal/domain/dossier';
import { decideVerdict, nextAttemptAt, type Assessment } from '../src/internal/domain/verdict';
import type { AiPort, AuditReport, AuditRepository, AuditRequest, CatalogPort, CompletedAudit, ImageAnalyzer, ReportStore, ReviewSummary } from '../src/internal/application/ports';
import { EnqueueAudit, GetReviewReports, RunAuditWorker } from '../src/internal/application/use-cases';
import { MediaFetcher } from '../src/internal/infrastructure/media-fetcher';
import { SharpImageAnalyzer } from '../src/internal/infrastructure/sharp-image-analyzer';

const LOT_ID = 'b0000000-0000-4000-8000-000000000001';
const SELLER = 'a0000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-29T12:00:00Z');

const LOT: LotSheet = {
  lotId: LOT_ID,
  sellerId: SELLER,
  status: 'PENDIENTE_AUDITORIA',
  title: 'Retrato de la costa',
  description: 'Oleo de la costa caribe.',
  artistName: 'Ana Prueba',
  creationYear: 1925,
  materials: 'Oleo sobre lienzo',
  widthCm: 60,
  heightCm: 80,
  provenance: 'Coleccion privada',
  images: [{ url: 'http://artauction-media.web.garage.localhost:3902/lots/x/1.jpg', perceptualHash: 'ffffffffffffff00' }],
};

const GOOD_IMAGE: ImageMetrics = {
  width: 1500,
  height: 2000,
  format: 'jpeg',
  bytes: 400_000,
  sharpness: 300,
  entropy: 7.1,
  saturation: 0.4,
  dominantColor: '#806040',
  exif: { software: null, camera: 'Canon EOS R6', takenAt: '2026-01-10T10:00:00.000Z', generatorMarker: null },
};

const AI_RESULT: Assessment = {
  model: 'gemini-test',
  promptVersion: 'v2',
  score: 82,
  critical: false,
  priceMin: 400,
  priceMax: 800,
  findings: [],
};

describe('expediente y reglas', () => {
  it('detecta materiales anacronicos y cita lo declarado', () => {
    const findings = applyRules({ ...LOT, materials: 'Acrilico sobre tela', creationYear: 1920 }, [GOOD_IMAGE], []);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'MATERIAL_ANACHRONISM', severity: 'CRITICAL', evidence: ['lot.declared_year', 'lot.declared_materials'] }),
    );
  });

  it('una imagen de otro vendedor es critica; la del mismo vendedor, advertencia', () => {
    const other = applyRules(LOT, [GOOD_IMAGE], [{ lotId: 'otro', sellerId: 'vendedor-b', queryHash: 'ff', distance: 2 }]);
    expect(other.find((finding) => finding.code === 'DUPLICATE_IMAGE_OTHER_SELLER')?.severity).toBe('CRITICAL');
    const same = applyRules(LOT, [GOOD_IMAGE], [{ lotId: 'otro', sellerId: SELLER, queryHash: 'ff', distance: 2 }]);
    expect(same.find((finding) => finding.code === 'DUPLICATE_IMAGE_SAME_SELLER')?.severity).toBe('WARNING');
  });

  it('marca baja resolucion, desenfoque, proporcion distinta y metadatos de generador', () => {
    const image: ImageMetrics = {
      ...GOOD_IMAGE,
      width: 600,
      height: 300,
      sharpness: 10,
      exif: { ...GOOD_IMAGE.exif, generatorMarker: 'Midjourney' },
    };
    const codes = applyRules(LOT, [image], []).map((finding) => finding.code);
    expect(codes).toEqual(expect.arrayContaining(['LOW_RESOLUTION', 'BLURRY_IMAGE', 'ASPECT_MISMATCH', 'AI_GENERATOR_METADATA']));
    expect(generatorMarker(['Adobe Photoshop', 'Made with Stable Diffusion XL'])).toBe('Stable Diffusion');
  });

  it('una obra limpia no genera hallazgos y su huella es estable', () => {
    const first = buildDossier(LOT, [GOOD_IMAGE], []);
    expect(first.ruleFindings).toEqual([]);
    expect(buildDossier(LOT, [GOOD_IMAGE], []).hash).toBe(first.hash);
    expect(buildDossier({ ...LOT, title: 'Otro titulo' }, [GOOD_IMAGE], []).hash).not.toBe(first.hash);
    expect(first.evidence.map((item) => item.code)).toEqual(expect.arrayContaining(['img1.aspect', 'img1.exif.camera', 'lot.declared_aspect']));
  });

  it('decide el veredicto y espacia los reintentos', () => {
    expect(decideVerdict(82, false)).toBe('APROBADO');
    expect(decideVerdict(39, false)).toBe('REVISION_MANUAL');
    expect(decideVerdict(95, true)).toBe('REVISION_MANUAL');
    expect(nextAttemptAt(NOW, 1).getTime() - NOW.getTime()).toBe(10_000);
    expect(nextAttemptAt(NOW, 3).getTime() - NOW.getTime()).toBe(40_000);
    expect(nextAttemptAt(NOW, 20).getTime() - NOW.getTime()).toBe(300_000);
  });
});

class MemoryAudits implements AuditRepository {
  requests: AuditRequest[] = [];
  completed: CompletedAudit[] = [];
  skipped: string[] = [];
  retries: Array<{ attempts: number; availableAt: Date }> = [];
  cache = new Map<string, Assessment>();
  inbox = new Set<string>();

  enqueueOnce(eventId: string, lotId: string) {
    if (this.inbox.has(eventId)) {
      return Promise.resolve(false);
    }
    this.inbox.add(eventId);
    this.requests.push({ id: `r${String(this.requests.length + 1)}`, lotId, attempts: 0 });
    return Promise.resolve(true);
  }
  claimDue() {
    const due = this.requests;
    this.requests = [];
    return Promise.resolve(due);
  }
  complete(_requestId: string, audit: CompletedAudit) {
    this.completed.push(audit);
    return Promise.resolve();
  }
  skip(requestId: string) {
    this.skipped.push(requestId);
    return Promise.resolve();
  }
  retryLater(_requestId: string, attempts: number, availableAt: Date) {
    this.retries.push({ attempts, availableAt });
    return Promise.resolve();
  }
  cachedAssessment(hash: string) {
    return Promise.resolve(this.cache.get(hash) ?? null);
  }
  saveAssessment(hash: string, assessment: Assessment) {
    this.cache.set(hash, assessment);
    return Promise.resolve();
  }
  latestSummaries() {
    return Promise.resolve([]);
  }
  latestForReview(lotIds: readonly string[]) {
    return Promise.resolve(
      this.completed
        .filter((audit) => lotIds.includes(audit.lotId))
        .map((audit): ReviewSummary => ({
          summaryId: audit.summaryId,
          lotId: audit.lotId,
          score: audit.assessment.score,
          decidedBy: audit.decidedBy,
          modelName: audit.assessment.model,
          reportId: audit.reportId,
          createdAt: NOW,
        })),
    );
  }
}

function harness(options: { lot?: LotSheet | null; image?: ImageMetrics | null; similarSeller?: string; ai?: () => Promise<Assessment> } = {}) {
  const audits = new MemoryAudits();
  const reports: AuditReport[] = [];
  const aiCalls: Dossier[] = [];
  const store: ReportStore = {
    save: (report) => {
      reports.push(report);
      return Promise.resolve();
    },
    findings: (ids) =>
      Promise.resolve(
        new Map(
          reports
            .filter((report) => ids.includes(report.id))
            .map((report) => {
              const values = new Map((report.dossier?.evidence ?? []).map((item) => [item.code, item.value]));
              return [report.id, report.assessment.findings.map((finding) => ({ ...finding, evidence: finding.evidence.map((code) => ({ code, value: values.get(code) ?? 'sin dato' })) }))];
            }),
        ),
      ),
  };
  const catalog: CatalogPort = {
    lot: () => Promise.resolve(options.lot === undefined ? LOT : options.lot),
    similarImages: () =>
      Promise.resolve(options.similarSeller ? [{ lotId: 'otro', sellerId: options.similarSeller, queryHash: 'ff', distance: 1 }] : []),
  };
  const images: ImageAnalyzer = { analyze: () => Promise.resolve(options.image === undefined ? GOOD_IMAGE : options.image) };
  const ai: AiPort = {
    audit: (dossier) => {
      aiCalls.push(dossier);
      return options.ai ? options.ai() : Promise.resolve(AI_RESULT);
    },
  };
  const worker = new RunAuditWorker({ audits, reports: store, catalog, images, ai, clock: { now: () => NOW }, logger: new StructuredLogger('test', () => undefined) });
  return { audits, reports, aiCalls, worker, store };
}

function payloadOf(event: DomainEvent | undefined): Record<string, unknown> {
  return event?.payload ?? {};
}

describe('worker de auditoria', () => {
  it('encola una sola vez por evento y valida el lote', async () => {
    const audits = new MemoryAudits();
    const enqueue = new EnqueueAudit(audits);
    expect(await enqueue.execute({ eventId: 'e1', lotId: LOT_ID })).toBe(true);
    expect(await enqueue.execute({ eventId: 'e1', lotId: LOT_ID })).toBe(false);
    expect(() => enqueue.execute({ eventId: 'e2', lotId: 'no-uuid' })).toThrow();
  });

  it('consulta a la IA, cachea su evaluacion y emite AuditCompleted aprobado', async () => {
    const { audits, reports, aiCalls, worker } = harness();
    await audits.enqueueOnce('e1', LOT_ID);
    expect(await worker.tick()).toBe(1);
    expect(aiCalls).toHaveLength(1);
    expect(audits.cache.size).toBe(1);
    const audit = audits.completed[0];
    expect(audit?.decidedBy).toBe('AI');
    expect(audit?.verdict).toBe('APROBADO');
    expect(payloadOf(audit?.event)).toMatchObject({ lotId: LOT_ID, sellerId: SELLER, title: LOT.title, verdict: 'APROBADO', score: 82 });
    expect(reports[0]?.id).toBe(audit?.summaryId);
    expect(reports[0]?.dossier?.hash).toBe(audit?.dossierHash);
  });

  it('cortocircuito: una regla critica decide sin gastar tokens', async () => {
    const { audits, aiCalls, worker } = harness({ similarSeller: 'vendedor-b' });
    await audits.enqueueOnce('e1', LOT_ID);
    await worker.tick();
    expect(aiCalls).toHaveLength(0);
    expect(audits.completed[0]?.decidedBy).toBe('RULES');
    expect(audits.completed[0]?.verdict).toBe('REVISION_MANUAL');
  });

  it('el mismo expediente reutiliza la evaluacion cacheada', async () => {
    const { audits, aiCalls, worker } = harness();
    await audits.enqueueOnce('e1', LOT_ID);
    await worker.tick();
    await audits.enqueueOnce('e2', LOT_ID);
    await worker.tick();
    expect(aiCalls).toHaveLength(1);
    expect(audits.completed).toHaveLength(2);
  });

  it('no cachea la evaluacion local para que una clave posterior consulte al modelo', async () => {
    const { audits, worker } = harness({ ai: () => Promise.resolve({ ...AI_RESULT, model: 'local-rules' }) });
    await audits.enqueueOnce('e1', LOT_ID);
    await worker.tick();
    expect(audits.cache.size).toBe(0);
  });

  it('reintenta con backoff si la IA falla y al quinto intento va a revision manual', async () => {
    const { audits, worker } = harness({ ai: () => Promise.reject(new Error('UNAVAILABLE')) });
    audits.requests.push({ id: 'r1', lotId: LOT_ID, attempts: 0 });
    await worker.tick();
    expect(audits.retries).toEqual([{ attempts: 1, availableAt: new Date(NOW.getTime() + 10_000) }]);
    expect(audits.completed).toHaveLength(0);
    audits.requests.push({ id: 'r1', lotId: LOT_ID, attempts: 4 });
    await worker.tick();
    expect(audits.completed[0]?.decidedBy).toBe('FALLBACK');
    expect(payloadOf(audits.completed[0]?.event)).toMatchObject({ verdict: 'REVISION_MANUAL' });
  });

  it('el administrador ve el expediente con el valor de cada evidencia citada', async () => {
    const { audits, worker, store } = harness({ similarSeller: 'vendedor-b' });
    await audits.enqueueOnce('e1', LOT_ID);
    await worker.tick();
    const reviews = new GetReviewReports(audits, store);
    const [report] = await reviews.execute({ role: 'ADMIN' }, [LOT_ID]);
    expect(report?.decidedBy).toBe('RULES');
    expect(report?.findings[0]).toMatchObject({
      code: 'DUPLICATE_IMAGE_OTHER_SELLER',
      severity: 'CRITICAL',
      evidence: [{ code: 'catalog.duplicate1', value: 'obra otro, otro vendedor, distancia 1' }],
    });
    await expect(reviews.execute({ role: 'SELLER' }, [LOT_ID])).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
  });

  it('omite una obra que ya no espera auditoria', async () => {
    const { audits, aiCalls, worker } = harness({ lot: { ...LOT, status: 'PUBLICADA' } });
    await audits.enqueueOnce('e1', LOT_ID);
    await worker.tick();
    expect(audits.skipped).toEqual(['r1']);
    expect(aiCalls).toHaveLength(0);
  });
});

describe('descarga y analisis de imagenes', () => {
  const fetcher = new MediaFetcher({
    allowedHosts: ['images.metmuseum.org'],
    publicMediaBase: 'http://artauction-media.web.garage.localhost:3902',
    internalMediaBase: 'http://127.0.0.1:1',
    timeoutMs: 500,
    maxBytes: 1_000_000,
  });

  it('rechaza hosts no permitidos, http externo y credenciales en la URL', async () => {
    expect(await fetcher.fetch('https://169.254.169.254/latest/meta-data')).toBeNull();
    expect(await fetcher.fetch('http://images.metmuseum.org/a.jpg')).toBeNull();
    expect(await fetcher.fetch('https://user:pass@images.metmuseum.org/a.jpg')).toBeNull();
    expect(await fetcher.fetch('no es una url')).toBeNull();
  });

  it('mide una imagen real: tamano, nitidez y color dominante', async () => {
    const stripes = Buffer.alloc(400 * 300 * 3);
    for (let index = 0; index < stripes.length; index += 3) {
      const column = (index / 3) % 400;
      const value = Math.floor(column / 10) % 2 === 0 ? 230 : 20;
      stripes[index] = value;
      stripes[index + 1] = value;
      stripes[index + 2] = value;
    }
    const png = await sharp(stripes, { raw: { width: 400, height: 300, channels: 3 } }).png().toBuffer();
    const analyzer = new SharpImageAnalyzer({ fetch: () => Promise.resolve(new Uint8Array(png)) } as unknown as MediaFetcher);
    const metrics = await analyzer.analyze('http://artauction-media.web.garage.localhost:3902/x.png');
    expect(metrics).toMatchObject({ width: 400, height: 300, format: 'png' });
    expect(metrics?.sharpness).toBeGreaterThan(100);
    expect(metrics?.saturation).toBeLessThan(0.05);
    expect(metrics?.exif.generatorMarker).toBeNull();
  });
});
