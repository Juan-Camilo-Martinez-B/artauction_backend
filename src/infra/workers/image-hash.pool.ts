import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { perceptualHash } from './perceptual-hash';

interface HashReply {
  id: number;
  hash?: string;
  error?: string;
}

@Injectable()
export class ImageHashPool implements OnModuleDestroy {
  private readonly workers: Worker[] = [];
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (hash: string) => void; reject: (error: Error) => void }>();

  constructor() {
    if (process.env['NODE_ENV'] === 'test') {
      return;
    }
    const file = join(__dirname, '../../workers/image-hash.worker.js');
    const size = Math.max(1, availableParallelism() - 1);
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(file);
      worker.on('message', (message: HashReply) => {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.hash) {
          pending.resolve(message.hash);
          return;
        }
        pending.reject(new Error(message.error ?? 'hash failed'));
      });
      this.workers.push(worker);
    }
  }

  hash(bytes: Buffer): Promise<string> {
    const worker = this.workers[this.seq % Math.max(this.workers.length, 1)];
    if (!worker || this.workers.length === 0) {
      return perceptualHash(bytes);
    }
    const id = this.seq;
    this.seq += 1;
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, bytes: copy }, [copy]);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
