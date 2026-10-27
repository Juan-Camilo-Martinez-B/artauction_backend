import { Server, type ServiceDefinition, type UntypedServiceImplementation } from '@grpc/grpc-js';
import { HealthImplementation } from 'grpc-health-check';
import { serverCredentials, type StructuredLogger, type TlsSettings } from '@artauction/platform';

export interface ServiceBinding {
  name: string;
  definition: ServiceDefinition;
  implementation: UntypedServiceImplementation;
}

export interface RunningServer {
  port: number;
  shutdown(): Promise<void>;
}

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * Arranca un servidor gRPC con los servicios del microservicio y el protocolo
 * estandar grpc.health.v1. Al cerrar marca NOT_SERVING antes de drenar, para
 * que el balanceador deje de enviar trafico.
 */
export async function startGrpcServer(options: {
  host: string;
  port: number;
  tls: TlsSettings;
  services: ServiceBinding[];
  logger: StructuredLogger;
}): Promise<RunningServer> {
  const server = new Server({
    'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
    'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
    'grpc.keepalive_permit_without_calls': 1,
  });
  const health = new HealthImplementation({ '': 'NOT_SERVING' });
  health.addToServer(server);
  for (const binding of options.services) {
    server.addService(binding.definition, binding.implementation);
    health.setStatus(binding.name, 'NOT_SERVING');
  }
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${options.host}:${String(options.port)}`, serverCredentials(options.tls), (error, bound) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(bound);
    });
  });
  health.setStatus('', 'SERVING');
  for (const binding of options.services) {
    health.setStatus(binding.name, 'SERVING');
  }
  options.logger.log(`gRPC escuchando en ${options.host}:${String(port)}`, 'grpc');
  return {
    port,
    shutdown: () =>
      new Promise<void>((resolve) => {
        health.setStatus('', 'NOT_SERVING');
        server.tryShutdown(() => {
          resolve();
        });
      }),
  };
}
