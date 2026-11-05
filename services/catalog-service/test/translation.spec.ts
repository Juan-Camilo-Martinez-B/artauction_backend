import type { LotTranslator, TranslatedTexts, TranslationJob, TranslationSource, TranslationStore } from '../src/internal/application/ports';
import { TranslationWorker } from '../src/internal/application/translation-worker';
import { textHash, translationRetryDelayMs, TRANSLATION_MAX_ATTEMPTS, type TranslatableTexts } from '../src/internal/domain/translation';

const TEXTS: TranslatableTexts = {
  title: 'Estatua gótica',
  description: 'Figura de tamaño natural envuelta en un manto.',
  materials: 'Piedra',
  provenance: null,
};

/** Cola en memoria que anota lo que hace el worker. */
class MemoryStore implements TranslationStore {
  readonly saved: Array<{ jobId: string; sourceHash: string; result: TranslatedTexts }> = [];
  readonly discarded: string[] = [];
  readonly failed: Array<{ jobId: string; error: string; retryAt: Date | null }> = [];
  enqueued = 0;

  constructor(
    private jobs: TranslationJob[],
    private readonly sources: Map<string, TranslationSource>,
  ) {}

  enqueueStale(): Promise<number> {
    return Promise.resolve(this.enqueued);
  }
  claimNext(): Promise<TranslationJob | null> {
    const [next, ...rest] = this.jobs;
    this.jobs = rest;
    return Promise.resolve(next ?? null);
  }
  sourceOf(lotId: string): Promise<TranslationSource | null> {
    return Promise.resolve(this.sources.get(lotId) ?? null);
  }
  save(job: TranslationJob, sourceHash: string, result: TranslatedTexts): Promise<void> {
    this.saved.push({ jobId: job.id, sourceHash, result });
    return Promise.resolve();
  }
  discard(jobId: string): Promise<void> {
    this.discarded.push(jobId);
    return Promise.resolve();
  }
  fail(jobId: string, error: string, retryAt: Date | null): Promise<void> {
    this.failed.push({ jobId, error, retryAt });
    return Promise.resolve();
  }
}

const RESULT: TranslatedTexts = {
  sourceLocale: 'es',
  model: 'fake-mt',
  translations: [{ locale: 'en', texts: { ...TEXTS, title: 'Gothic statue' } }],
};
const translator: LotTranslator = { translate: () => Promise.resolve(RESULT) };
const failing: LotTranslator = { translate: () => Promise.reject(new Error('Opus-MT no responde')) };
const OPTIONS = { enqueueBatch: 50, translateBatch: 5, leaseMs: 60_000 };
const log = { warn: () => undefined };
const NOW = new Date('2026-11-04T12:00:00.000Z');

function job(id: string, lotId: string, sourceHash: string, attempts = 1): TranslationJob {
  return { id, lotId, sourceHash, attempts };
}

describe('huella del texto', () => {
  it('cambia con cualquier campo y no confunde un campo con otro', () => {
    const base = textHash(TEXTS);
    expect(textHash({ ...TEXTS })).toBe(base);
    expect(textHash({ ...TEXTS, materials: 'Piedra tallada' })).not.toBe(base);
    expect(textHash({ ...TEXTS, provenance: '' })).toBe(base);
    expect(textHash({ title: 'ab', description: 'c', materials: '', provenance: null })).not.toBe(
      textHash({ title: 'a', description: 'bc', materials: '', provenance: null }),
    );
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it('los reintentos esperan cada vez el doble, hasta 30 minutos', () => {
    expect(translationRetryDelayMs(1)).toBe(30_000);
    expect(translationRetryDelayMs(2)).toBe(60_000);
    expect(translationRetryDelayMs(20)).toBe(30 * 60_000);
  });
});

describe('worker de traduccion', () => {
  it('traduce una ficha publica y guarda la traduccion con la huella del texto', async () => {
    const hash = textHash(TEXTS);
    const store = new MemoryStore([job('j1', 'lot-1', hash)], new Map([['lot-1', { texts: TEXTS, visibility: 'PUBLIC' }]]));
    store.enqueued = 1;
    const result = await new TranslationWorker(store, translator, OPTIONS, log).tick();
    expect(result).toEqual({ enqueued: 1, processed: 1 });
    expect(store.saved).toEqual([{ jobId: 'j1', sourceHash: hash, result: RESULT }]);
  });

  it('descarta la solicitud si la ficha cambio, dejo de ser publica o ya no existe', async () => {
    const store = new MemoryStore(
      [job('cambio', 'lot-1', textHash({ ...TEXTS, title: 'Titulo viejo' })), job('privada', 'lot-2', textHash(TEXTS)), job('borrada', 'lot-3', textHash(TEXTS))],
      new Map<string, TranslationSource>([
        ['lot-1', { texts: TEXTS, visibility: 'PUBLIC' }],
        ['lot-2', { texts: TEXTS, visibility: 'PRIVATE' }],
      ]),
    );
    await new TranslationWorker(store, translator, OPTIONS, log).tick();
    expect(store.discarded).toEqual(['cambio', 'privada', 'borrada']);
    expect(store.saved).toEqual([]);
  });

  it('un fallo se reintenta mas tarde; al quinto intento la solicitud queda fallida', async () => {
    const hash = textHash(TEXTS);
    const sources = new Map([['lot-1', { texts: TEXTS, visibility: 'PUBLIC' as const }]]);
    const store = new MemoryStore([job('j1', 'lot-1', hash, 1), job('j2', 'lot-1', hash, TRANSLATION_MAX_ATTEMPTS)], sources);
    await new TranslationWorker(store, failing, OPTIONS, log, () => NOW).tick();
    expect(store.failed).toEqual([
      { jobId: 'j1', error: 'Opus-MT no responde', retryAt: new Date(NOW.getTime() + 30_000) },
      { jobId: 'j2', error: 'Opus-MT no responde', retryAt: null },
    ]);
  });

  it('no traduce mas fichas de las que permite cada pasada', async () => {
    const hash = textHash(TEXTS);
    const jobs = Array.from({ length: 4 }, (_value, index) => job(`j${String(index)}`, 'lot-1', hash));
    const store = new MemoryStore(jobs, new Map([['lot-1', { texts: TEXTS, visibility: 'PUBLIC' as const }]]));
    const result = await new TranslationWorker(store, translator, { ...OPTIONS, translateBatch: 2 }, log).tick();
    expect(result.processed).toBe(2);
    expect(store.saved).toHaveLength(2);
  });
});
