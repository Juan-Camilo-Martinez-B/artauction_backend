import { isMainThread, parentPort } from 'node:worker_threads';
import { perceptualHash } from '../infra/workers/perceptual-hash';

interface HashRequest {
  id: number;
  bytes: ArrayBuffer;
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (message: HashRequest) => {
    void perceptualHash(Buffer.from(message.bytes))
      .then((hash) => {
        port.postMessage({ id: message.id, hash });
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : 'hash failed';
        port.postMessage({ id: message.id, error: text });
      });
  });
}
