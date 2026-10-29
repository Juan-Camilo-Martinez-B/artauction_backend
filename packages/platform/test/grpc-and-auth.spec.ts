import { generateKeyPairSync } from 'node:crypto';
import { status } from '@grpc/grpc-js';
import { sign } from 'jsonwebtoken';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../src/auth/principal';
import { TokenVerifier } from '../src/auth/token-verifier';
import { DomainError } from '../src/errors/domain-error';
import { toHttpError, toServiceError } from '../src/grpc/status-mapping';

describe('mapeo de errores', () => {
  it('conserva el mensaje de un error de dominio', () => {
    const error = toServiceError(DomainError.conflict('El correo ya esta registrado'));
    expect(error.code).toBe(status.ALREADY_EXISTS);
    expect(toHttpError(error)).toEqual({ statusCode: 409, error: 'Conflict', message: 'El correo ya esta registrado' });
  });

  it('oculta el detalle de un error inesperado', () => {
    const error = toServiceError(new Error('connection string postgres://secreto'));
    expect(error.code).toBe(status.INTERNAL);
    expect(error.details).not.toContain('secreto');
    expect(toHttpError(error).statusCode).toBe(500);
  });

  it('traduce una precondicion fallida a 409 como hacia el monolito', () => {
    expect(toHttpError(toServiceError(DomainError.precondition('La subasta no esta activa'))).statusCode).toBe(409);
  });
});

describe('TokenVerifier', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const verifier = new TokenVerifier(pem);
  const base = { issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, expiresIn: 60 } as const;

  it('acepta un access token RS256 valido', () => {
    const token = sign({ typ: 'access', email: 'leo@artauction.local', role: 'USER' }, privateKey, {
      ...base,
      algorithm: 'RS256',
      subject: 'u1',
    });
    expect(verifier.verifyBearer(`Bearer ${token}`)).toEqual({
      kind: 'user',
      userId: 'u1',
      email: 'leo@artauction.local',
      role: 'USER',
    });
  });

  it('reconoce un token de servicio', () => {
    const token = sign({ typ: 'service' }, privateKey, { ...base, algorithm: 'RS256', subject: 'catalog-service' });
    expect(verifier.verify(token)).toEqual({ kind: 'service', clientId: 'catalog-service' });
  });

  it('rechaza HS256 aunque el secreto sea la clave publica', () => {
    const forged = sign({ typ: 'access', email: 'x@y.z', role: 'ADMIN' }, pem, {
      ...base,
      algorithm: 'HS256',
      subject: 'u1',
    });
    expect(() => verifier.verify(forged)).toThrow(/sesion/);
  });

  it('rechaza un emisor ajeno, un rol desconocido y la falta de token', () => {
    const foreign = sign({ typ: 'access', email: 'x@y.z', role: 'USER' }, privateKey, {
      ...base,
      issuer: 'otro',
      algorithm: 'RS256',
      subject: 'u1',
    });
    const badRole = sign({ typ: 'access', email: 'x@y.z', role: 'ROOT' }, privateKey, {
      ...base,
      algorithm: 'RS256',
      subject: 'u1',
    });
    expect(() => verifier.verify(foreign)).toThrow(/sesion/);
    expect(() => verifier.verify(badRole)).toThrow(/sesion/);
    expect(() => verifier.verifyBearer(undefined)).toThrow(/Falta/);
  });
});
