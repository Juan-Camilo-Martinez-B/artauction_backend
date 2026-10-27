import { readFileSync } from 'node:fs';
import { credentials, ServerCredentials, type ChannelCredentials } from '@grpc/grpc-js';

export interface TlsSettings {
  enabled: boolean;
  caPath?: string;
  certPath?: string;
  keyPath?: string;
}

/**
 * Credenciales del servidor gRPC. Sin TLS solo para desarrollo local; con TLS
 * exige certificado y clave, y si hay CA tambien verifica al cliente (mTLS).
 */
export function serverCredentials(tls: TlsSettings): ServerCredentials {
  if (!tls.enabled) {
    return ServerCredentials.createInsecure();
  }
  if (!tls.certPath || !tls.keyPath) {
    throw new Error('GRPC_TLS requiere GRPC_TLS_CERT y GRPC_TLS_KEY');
  }
  const ca = tls.caPath ? readFileSync(tls.caPath) : null;
  return ServerCredentials.createSsl(
    ca,
    [{ cert_chain: readFileSync(tls.certPath), private_key: readFileSync(tls.keyPath) }],
    ca !== null,
  );
}

export function channelCredentials(tls: TlsSettings): ChannelCredentials {
  if (!tls.enabled) {
    return credentials.createInsecure();
  }
  const ca = tls.caPath ? readFileSync(tls.caPath) : null;
  const key = tls.keyPath ? readFileSync(tls.keyPath) : null;
  const cert = tls.certPath ? readFileSync(tls.certPath) : null;
  return credentials.createSsl(ca, key, cert);
}
