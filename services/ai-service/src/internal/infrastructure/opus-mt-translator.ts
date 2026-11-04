import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Translator } from '../application/ports';
import type { Locale } from '../domain/translation';

/** Modelos Opus-MT (Helsinki-NLP, Apache 2.0) convertidos a ONNX para Transformers.js. */
export const OPUS_MT_MODELS: Readonly<Record<string, string>> = {
  'es-en': 'Xenova/opus-mt-es-en',
  'en-es': 'Xenova/opus-mt-en-es',
};

export interface OpusMtOptions {
  /** Carpeta donde quedan los modelos descargados. */
  cacheDir: string;
  /** Tope por llamada. La primera incluye la descarga del modelo. */
  timeoutMs: number;
}

interface Pending {
  resolve: (outputs: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerReply {
  id: number;
  outputs?: string[];
  error?: string;
}

/**
 * Traductor local: los modelos corren en un hilo aparte (opus-mt.worker) que
 * se crea con la primera traduccion y conserva los modelos en memoria. Si el
 * hilo se cae, las traducciones en curso fallan y el siguiente pedido crea
 * uno nuevo. Los textos nunca salen del servidor.
 */
export class OpusMtTranslator implements Translator {
  readonly name = 'opus-mt';
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: OpusMtOptions) {}

  translate(texts: string[], from: Locale, to: Locale): Promise<string[]> {
    if (texts.length === 0) {
      return Promise.resolve([]);
    }
    const direction = `${from}-${to}`;
    if (!OPUS_MT_MODELS[direction]) {
      return Promise.reject(new Error(`No hay modelo para ${direction}`));
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('La traduccion tardo demasiado'));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, direction, texts });
    });
  }

  /** Nest lo llama al apagar el servicio. */
  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  /** Libera el hilo y sus modelos. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('ai-service se esta apagando'));
    await worker?.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(path.join(__dirname, 'opus-mt.worker.js'), {
      workerData: { cacheDir: this.options.cacheDir, models: OPUS_MT_MODELS },
    });
    // El hilo no mantiene vivo el proceso: el apagado no espera por el.
    worker.unref();
    worker.on('message', (reply: WorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) {
        return;
      }
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.error !== undefined || !reply.outputs) {
        pending.reject(new Error(reply.error ?? 'Respuesta vacia del traductor'));
      } else {
        pending.resolve(reply.outputs);
      }
    });
    const reset = (error: Error) => {
      if (this.worker === worker) {
        this.worker = null;
      }
      this.failAll(error);
    };
    worker.on('error', reset);
    worker.on('exit', (code) => {
      reset(new Error(`El hilo de traduccion termino (${String(code)})`));
    });
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
