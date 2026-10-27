import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verify, type JwtPayload } from 'jsonwebtoken';
import { DomainError } from '../errors/domain-error';
import { isUserRole, TOKEN_AUDIENCE, TOKEN_ISSUER, type Principal } from './principal';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Verifica access tokens y tokens de servicio emitidos por identity-service.
 * Solo acepta RS256 con el emisor y la audiencia del sistema, asi un token
 * firmado con otro algoritmo (por ejemplo "none" o HS256) se rechaza.
 */
export class TokenVerifier {
  private readonly key: KeyObject;

  constructor(publicKeyPem: string) {
    this.key = createPublicKey(publicKeyPem);
  }

  static fromFile(path: string): TokenVerifier {
    return new TokenVerifier(readFileSync(path, 'utf8'));
  }

  verify(token: string): Principal {
    let payload: JwtPayload | string;
    try {
      payload = verify(token, this.key, {
        algorithms: ['RS256'],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
      });
    } catch {
      throw DomainError.unauthenticated('La sesion no es valida');
    }
    if (typeof payload === 'string') {
      throw DomainError.unauthenticated('La sesion no es valida');
    }
    return toPrincipal(payload);
  }

  verifyBearer(header: string | undefined): Principal {
    const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
    if (token === undefined) {
      throw DomainError.unauthenticated('Falta el token de acceso');
    }
    return this.verify(token);
  }
}

function toPrincipal(payload: JwtPayload): Principal {
  const subject = payload.sub;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw DomainError.unauthenticated('La sesion no es valida');
  }
  const kind: unknown = payload['typ'];
  if (kind === 'service') {
    return { kind: 'service', clientId: subject };
  }
  const email: unknown = payload['email'];
  const role: unknown = payload['role'];
  if (kind !== 'access' || typeof email !== 'string' || !isUserRole(role)) {
    throw DomainError.unauthenticated('La sesion no es valida');
  }
  return { kind: 'user', userId: subject, email, role };
}
