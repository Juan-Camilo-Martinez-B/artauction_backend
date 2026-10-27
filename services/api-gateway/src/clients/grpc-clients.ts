import { identityV1 } from '@artauction/contracts';
import { channelCredentials } from '@artauction/platform';
import type { GatewayConfig } from '../config';

export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** Un canal HTTP/2 persistente por servicio; grpc-js multiplexa las llamadas. */
export function createIdentityClient(config: GatewayConfig): identityV1.IdentityServiceClient {
  return new identityV1.IdentityServiceClient(config.IDENTITY_GRPC_URL, channelCredentials(config.tls), {
    'grpc.keepalive_time_ms': 30_000,
  });
}
