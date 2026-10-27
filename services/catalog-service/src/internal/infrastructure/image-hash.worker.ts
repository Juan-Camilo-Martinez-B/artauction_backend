import { isMainThread, parentPort } from 'node:worker_threads';
import { perceptualHash } from './image-hash';

interface HashRequest {
  id: number;
  bytes: ArrayBuffer;
}

// Hilo de trabajo: el decodificado de imagen es CPU y no debe bloquear el event
// loop que atiende gRPC.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (message: HashRequest) => {
    perceptualHash(new Uint8Array(message.bytes)).then(
      (hash) => {
        port.postMessage({ id: message.id, hash });
      },
      (error: unknown) => {
        port.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'hash fallido' });
      },
    );
  });
}
