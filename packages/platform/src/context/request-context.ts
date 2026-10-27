import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Claves de metadata que viajan en cada llamada gRPC entre servicios. */
export const METADATA_KEYS = {
  correlationId: 'x-correlation-id',
  authorization: 'authorization',
  idempotencyKey: 'idempotency-key',
} as const;

export interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Ejecuta `work` con un contexto disponible para el logger y los clientes gRPC. */
export function runWithContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function correlationIdOrNew(candidate: string | undefined): string {
  return candidate !== undefined && /^[\w-]{8,64}$/.test(candidate) ? candidate : randomUUID();
}
