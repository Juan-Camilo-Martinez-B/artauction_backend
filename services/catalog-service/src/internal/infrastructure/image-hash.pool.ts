import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ImageHasher } from '../application/ports';

interface Pending {
  slot: Slot;
  resolve: (hash: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  worker: Worker;
  inFlight: number;
}

interface Reply {
  id: number;
  hash?: string;
  error?: string;
}

/**
 * Pool fijo de worker_threads (vCPU - 1) para el hash perceptual. Cada peticion
 * va al hilo con menos trabajo en curso. Si un hilo muere, sus peticiones se
 * rechazan y se reemplaza; ninguna promesa queda colgada (timeout por peticion).
 */
export class ImageHashPool implements ImageHasher {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private closed = false;

  constructor(
    private readonly workerFile: string,
    size = Math.max(1, availableParallelism() - 1),
    private readonly timeoutMs = 10_000,
  ) {
    for (let index = 0; index < size; index += 1) {
      this.slots.push(this.spawn());
    }
  }

  hash(bytes: Uint8Array): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error('El pool de hash esta cerrado'));
    }
    const slot = this.slots.reduce((best, current) => (current.inFlight < best.inFlight ? current : best));
    const id = (this.seq += 1);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, new Error('El hash de la imagen tardo demasiado'));
      }, this.timeoutMs);
      this.pending.set(id, { slot, resolve, reject, timer });
      slot.inFlight += 1;
      slot.worker.postMessage({ id, bytes: copy }, [copy]);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.pending.keys()]) {
      this.settle(id, new Error('El pool de hash se cerro'));
    }
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(this.workerFile), inFlight: 0 };
    slot.worker.on('message', (reply: Reply) => {
      this.settle(reply.id, reply.hash === undefined ? new Error(reply.error ?? 'hash fallido') : null, reply.hash);
    });
    slot.worker.on('error', () => {
      this.replace(slot);
    });
    slot.worker.on('exit', (code) => {
      if (code !== 0) {
        this.replace(slot);
      }
    });
    return slot;
  }

  private replace(dead: Slot): void {
    for (const [id, entry] of this.pending) {
      if (entry.slot === dead) {
        this.settle(id, new Error('El hilo de hash fallo'));
      }
    }
    const index = this.slots.indexOf(dead);
    if (index >= 0 && !this.closed) {
      this.slots[index] = this.spawn();
    }
  }

  private settle(id: number, error: Error | null, hash?: string): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.slot.inFlight -= 1;
    if (error || hash === undefined) {
      entry.reject(error ?? new Error('hash fallido'));
      return;
    }
    entry.resolve(hash);
  }
}
