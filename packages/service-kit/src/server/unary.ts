import type { handleUnaryCall, Metadata, sendUnaryData, ServerUnaryCall } from '@grpc/grpc-js';
import {
  correlationIdOrNew,
  isDomainError,
  METADATA_KEYS,
  runWithContext,
  toServiceError,
  type StructuredLogger,
} from '@artauction/platform';

export interface CallContext {
  correlationId: string;
  metadata: Metadata;
  /** Cabecera `authorization` tal como llego, sin verificar. */
  authorization: string | undefined;
}

export type UnaryHandler<Req, Res> = (request: Req, context: CallContext) => Promise<Res>;

export function readMetadata(metadata: Metadata, key: string): string | undefined {
  const value = metadata.get(key)[0];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Adapta un caso de uso asincrono a la firma de callback de grpc-js. Propaga el
 * correlation id al contexto, traduce errores de dominio a status gRPC y deja
 * en el log solo los errores inesperados.
 */
export function unary<Req, Res>(
  logger: StructuredLogger,
  rpc: string,
  handler: UnaryHandler<Req, Res>,
): handleUnaryCall<Req, Res> {
  return (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>) => {
    const correlationId = correlationIdOrNew(readMetadata(call.metadata, METADATA_KEYS.correlationId));
    const context: CallContext = {
      correlationId,
      metadata: call.metadata,
      authorization: readMetadata(call.metadata, METADATA_KEYS.authorization),
    };
    runWithContext({ correlationId }, () => {
      handler(call.request, context).then(
        (response) => {
          callback(null, response);
        },
        (error: unknown) => {
          if (!isDomainError(error)) {
            logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), undefined, rpc);
          }
          callback(toServiceError(error));
        },
      );
    });
  };
}
