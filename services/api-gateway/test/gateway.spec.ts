import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { identityV1 } from '@artauction/contracts';
import { DomainError, loadConfig, StructuredLogger } from '@artauction/platform';
import { startGrpcServer, unary, type RunningServer } from '@artauction/service-kit';
import { isMigrated } from '../src/api/http/legacy-proxy';
import { createGateway } from '../src/app';
import { GatewayConfig } from '../src/config';

describe('tabla de rutas migradas', () => {
  it('distingue prefijos exactos de prefijos parecidos', () => {
    expect(isMigrated('/auth/login')).toBe(true);
    expect(isMigrated('/auth?x=1')).toBe(true);
    expect(isMigrated('/authors')).toBe(false);
    expect(isMigrated('/lots/123/related')).toBe(true);
    expect(isMigrated('/admin/lots/1/resolve')).toBe(true);
    expect(isMigrated('/wallet/top-ups')).toBe(false);
  });
});

describe('gateway sobre identity y el monolito', () => {
  const logger = new StructuredLogger('test', () => undefined);
  let identity: RunningServer;
  let legacy: Server;
  let gateway: NestExpressApplication;
  let base: string;
  const seen: Array<{ url: string; body: string; forwardedFor: string | undefined }> = [];
  let seenAuthorization: string | undefined;

  beforeAll(async () => {
    const account = identityV1.Account.fromPartial({
      userId: 'u1',
      email: 'leo@artauction.local',
      role: identityV1.Role.ROLE_SELLER,
      displayName: 'Leo',
    });
    const implementation: identityV1.IdentityServiceServer = {
      register: unary(logger, 'Register', (request) =>
        request.email === 'dup@artauction.local'
          ? Promise.reject(DomainError.conflict('El correo ya esta registrado'))
          : Promise.resolve(identityV1.RegisterResponse.fromPartial({ account })),
      ),
      login: unary(logger, 'Login', () =>
        Promise.resolve(
          identityV1.LoginResponse.fromPartial({ tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: '15m' } }),
        ),
      ),
      refreshSession: unary(logger, 'RefreshSession', () => Promise.reject(DomainError.unauthenticated('Refresh token invalido'))),
      getAccount: unary(logger, 'GetAccount', (_request, context) => {
        seenAuthorization = context.authorization;
        return Promise.resolve(identityV1.GetAccountResponse.fromPartial({ account }));
      }),
      updateProfile: unary(logger, 'UpdateProfile', () => Promise.resolve(identityV1.UpdateProfileResponse.fromPartial({ account }))),
      getPublicProfile: unary(logger, 'GetPublicProfile', () => Promise.resolve(identityV1.GetPublicProfileResponse.fromPartial({}))),
      getSigningKeys: unary(logger, 'GetSigningKeys', () => Promise.resolve(identityV1.GetSigningKeysResponse.fromPartial({}))),
      issueServiceToken: unary(logger, 'IssueServiceToken', () =>
        Promise.resolve(identityV1.IssueServiceTokenResponse.fromPartial({})),
      ),
    };
    identity = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      tls: { enabled: false },
      logger,
      services: [{ name: 'identity', definition: identityV1.IdentityServiceService, implementation }],
    });

    legacy = createServer((request: IncomingMessage, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const forwarded = request.headers['x-forwarded-for'];
        seen.push({ url: request.url ?? '', body, forwardedFor: Array.isArray(forwarded) ? forwarded[0] : forwarded });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ from: 'monolito' }));
      });
    });
    await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));

    const config = loadConfig(GatewayConfig, {
      PORT: '3999',
      LEGACY_URL: `http://127.0.0.1:${String((legacy.address() as AddressInfo).port)}`,
      IDENTITY_GRPC_URL: `127.0.0.1:${String(identity.port)}`,
    });
    gateway = await createGateway(config, logger);
    await gateway.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${String((gateway.getHttpServer().address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await gateway.close();
    await identity.shutdown();
    await new Promise<void>((resolve) => {
      legacy.close(() => {
        resolve();
      });
    });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('responde el login con la forma del monolito', async () => {
    const response = await post('/auth/login', { email: 'leo@artauction.local', password: 'DevPassword!234' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: '15m' });
  });

  it('traduce el conflicto de registro a 409', async () => {
    const response = await post('/auth/register', { email: 'dup@artauction.local', password: 'DevPassword!234', displayName: 'Dup' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ statusCode: 409, error: 'Conflict', message: 'El correo ya esta registrado' });
  });

  it('devuelve la cuenta con el rol en texto y reenvia el token', async () => {
    const response = await fetch(`${base}/auth/me`, { headers: { authorization: 'Bearer token-de-prueba' } });
    expect(await response.json()).toEqual({
      userId: 'u1',
      email: 'leo@artauction.local',
      role: 'SELLER',
      displayName: 'Leo',
      avatarUrl: null,
    });
    expect(seenAuthorization).toBe('Bearer token-de-prueba');
  });

  it('valida la forma de la peticion antes de llamar al servicio', async () => {
    const response = await post('/auth/login', { email: 'no-es-correo', password: 'x', extra: true });
    expect(response.status).toBe(400);
  });

  it('reenvia lo no migrado al monolito con el cuerpo intacto y la IP del cliente', async () => {
    const response = await post('/wallet/top-ups', { coins: 500 });
    expect(await response.json()).toEqual({ from: 'monolito' });
    const last = seen.at(-1);
    expect(last?.url).toBe('/wallet/top-ups');
    expect(last?.body).toBe(JSON.stringify({ coins: 500 }));
    expect(last?.forwardedFor).toBeDefined();
  });
});
