import { Metadata, type CallOptions, type ClientUnaryCall, type ServiceError } from '@grpc/grpc-js';
import { currentContext, METADATA_KEYS } from '@artauction/platform';

type UnaryMethod<Req, Res> = (
  request: Req,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: Res) => void,
) => ClientUnaryCall;

export interface InvokeOptions {
  deadlineMs: number;
  /** Valor completo de la cabecera, por ejemplo "Bearer ey...". */
  authorization?: string;
  extra?: Record<string, string>;
}

/**
 * Llama a un metodo unario de un cliente generado y devuelve una promesa.
 * Siempre fija un deadline y propaga el correlation id de la peticion en curso.
 */
export function invoke<Req, Res>(method: UnaryMethod<Req, Res>, request: Req, options: InvokeOptions): Promise<Res> {
  const metadata = new Metadata();
  const correlationId = currentContext()?.correlationId;
  if (correlationId) {
    metadata.set(METADATA_KEYS.correlationId, correlationId);
  }
  if (options.authorization) {
    metadata.set(METADATA_KEYS.authorization, options.authorization);
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    metadata.set(key, value);
  }
  return new Promise<Res>((resolve, reject) => {
    method(request, metadata, { deadline: new Date(Date.now() + options.deadlineMs) }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}
