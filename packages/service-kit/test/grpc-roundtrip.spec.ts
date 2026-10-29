import { credentials, makeGenericClientConstructor, status, type ServiceError } from '@grpc/grpc-js';
import { service as healthService } from 'grpc-health-check';
import { aiV1 } from '@artauction/contracts';
import { DomainError, METADATA_KEYS, runWithContext, StructuredLogger } from '@artauction/platform';
import { invoke } from '../src/client/invoke';
import { startGrpcServer, type RunningServer } from '../src/server/grpc-server';
import { unary } from '../src/server/unary';

describe('servidor y cliente gRPC', () => {
  const lines: string[] = [];
  const logger = new StructuredLogger('test', (line) => lines.push(line));
  let server: RunningServer;
  let client: aiV1.AiServiceClient;
  let seenCorrelation: string | undefined;

  beforeAll(async () => {
    const implementation: aiV1.AiServiceServer = {
      auditArtwork: unary(logger, 'AuditArtwork', (request, context) => {
        seenCorrelation = context.correlationId;
        if (request.title === 'falla') {
          return Promise.reject(DomainError.precondition('La obra no se puede auditar'));
        }
        if (request.title === 'revienta') {
          return Promise.reject(new Error('detalle interno secreto'));
        }
        return Promise.resolve(aiV1.AuditArtworkResponse.fromPartial({ model: 'fake', score: 80 }));
      }),
      designGallery: unary(logger, 'DesignGallery', () => Promise.resolve(aiV1.DesignGalleryResponse.fromPartial({}))),
    };
    server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      tls: { enabled: false },
      services: [{ name: 'artauction.ai.v1.AiService', definition: aiV1.AiServiceService, implementation }],
      logger,
    });
    client = new aiV1.AiServiceClient(`127.0.0.1:${String(server.port)}`, credentials.createInsecure());
  });

  afterAll(async () => {
    client.close();
    await server.shutdown();
  });

  it('responde y propaga el correlation id', async () => {
    const response = await runWithContext({ correlationId: 'corr-12345678' }, () =>
      invoke(client.auditArtwork.bind(client), aiV1.AuditArtworkRequest.fromPartial({ title: 'ok' }), {
        deadlineMs: 2_000,
      }),
    );
    expect(response.score).toBe(80);
    expect(seenCorrelation).toBe('corr-12345678');
    expect(METADATA_KEYS.correlationId).toBe('x-correlation-id');
  });

  it('traduce un error de dominio a su status', async () => {
    const error = (await invoke(client.auditArtwork.bind(client), aiV1.AuditArtworkRequest.fromPartial({ title: 'falla' }), {
      deadlineMs: 2_000,
    }).catch((caught: unknown) => caught)) as ServiceError;
    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe('La obra no se puede auditar');
  });

  it('oculta el error inesperado al cliente y lo deja en el log', async () => {
    const error = (await invoke(
      client.auditArtwork.bind(client),
      aiV1.AuditArtworkRequest.fromPartial({ title: 'revienta' }),
      { deadlineMs: 2_000 },
    ).catch((caught: unknown) => caught)) as ServiceError;
    expect(error.code).toBe(status.INTERNAL);
    expect(error.details).not.toContain('secreto');
    expect(lines.some((line) => line.includes('detalle interno secreto'))).toBe(true);
  });

  it('expone grpc.health.v1 como SERVING', async () => {
    const HealthClient = makeGenericClientConstructor(healthService, 'Health');
    const health = new HealthClient(`127.0.0.1:${String(server.port)}`, credentials.createInsecure()) as unknown as {
      check: Parameters<typeof invoke<{ service: string }, { status: unknown }>>[0];
      close(): void;
    };
    const response = await invoke(health.check.bind(health), { service: 'artauction.ai.v1.AiService' }, {
      deadlineMs: 2_000,
    });
    health.close();
    expect(['SERVING', 1]).toContain(response.status);
  });
});
