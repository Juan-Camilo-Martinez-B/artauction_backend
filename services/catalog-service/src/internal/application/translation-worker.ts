import { textHash, translationRetryDelayMs, TRANSLATION_MAX_ATTEMPTS } from '../domain/translation';
import type { LotTranslator, TranslationJob, TranslationStore } from './ports';

/** Cuantas fichas encola el reconciliador por pasada y cuantas traduce. */
export interface TranslationWorkerOptions {
  enqueueBatch: number;
  translateBatch: number;
  leaseMs: number;
}

export interface TranslationWorkerLog {
  warn(message: string, context?: string): void;
}

/**
 * Mantiene traducidas las fichas publicas. En cada pasada:
 * 1. Reconcilia: encola las fichas publicas cuya version actual no tiene
 *    traduccion ni intento previo. Asi entran en un solo lugar las obras que se
 *    publican, las que se editan y las que ya existian.
 * 2. Traduce unas pocas solicitudes, de a una: el modelo usa la CPU de
 *    ai-service y la auditoria tiene prioridad.
 * Una solicitud cuya ficha cambio o dejo de ser publica se descarta: la
 * siguiente pasada encola la version nueva.
 */
export class TranslationWorker {
  constructor(
    private readonly store: TranslationStore,
    private readonly translator: LotTranslator,
    private readonly options: TranslationWorkerOptions,
    private readonly log: TranslationWorkerLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<{ enqueued: number; processed: number }> {
    const enqueued = await this.store.enqueueStale(this.options.enqueueBatch);
    let processed = 0;
    for (; processed < this.options.translateBatch; processed += 1) {
      const job = await this.store.claimNext(this.options.leaseMs);
      if (!job) {
        break;
      }
      await this.process(job);
    }
    return { enqueued, processed };
  }

  private async process(job: TranslationJob): Promise<void> {
    const source = await this.store.sourceOf(job.lotId);
    if (!source || source.visibility !== 'PUBLIC') {
      await this.store.discard(job.id);
      return;
    }
    const currentHash = textHash(source.texts);
    if (currentHash !== job.sourceHash) {
      await this.store.discard(job.id);
      return;
    }
    try {
      const result = await this.translator.translate(source.texts);
      await this.store.save(job, currentHash, result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'el traductor no respondio';
      const exhausted = job.attempts >= TRANSLATION_MAX_ATTEMPTS;
      const retryAt = exhausted ? null : new Date(this.now().getTime() + translationRetryDelayMs(job.attempts));
      this.log.warn(`traduccion de ${job.lotId} fallo (intento ${String(job.attempts)}): ${reason}`, 'translation');
      await this.store.fail(job.id, reason.slice(0, 500), retryAt);
    }
  }
}
