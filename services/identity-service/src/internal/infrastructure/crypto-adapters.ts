import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, timingSafeEqual, type KeyObject } from 'node:crypto';
import * as argon2 from 'argon2';
import { sign } from 'jsonwebtoken';
import { durationToSeconds, TOKEN_AUDIENCE, TOKEN_ISSUER } from '@artauction/platform';
import type {
  AccessClaims,
  Clock,
  IdGenerator,
  PasswordHasher,
  RefreshTokenCodec,
  ServiceClientRegistry,
  SigningKeyView,
  TokenIssuer,
} from '../application/ports';

export class Argon2PasswordHasher implements PasswordHasher {
  readonly decoyHash: Promise<string>;

  constructor() {
    this.decoyHash = this.hash(randomBytes(32).toString('base64url'));
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}

/**
 * Firma access tokens y tokens de servicio con RS256. El `kid` es una huella de
 * la clave publica para poder rotarla publicando varias claves a la vez.
 */
export class Rs256TokenIssuer implements TokenIssuer {
  private readonly privateKey: KeyObject;
  private readonly publicKeyPem: string;
  private readonly kid: string;

  constructor(
    privateKeyPem: string,
    readonly accessTtl: string,
    private readonly serviceTtl: string,
  ) {
    this.privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(this.privateKey);
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    this.kid = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
      .slice(0, 16);
  }

  issueAccess(claims: AccessClaims): Promise<string> {
    return Promise.resolve(
      sign({ typ: 'access', email: claims.email, role: claims.role }, this.privateKey, {
        algorithm: 'RS256',
        keyid: this.kid,
        subject: claims.userId,
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        expiresIn: durationToSeconds(this.accessTtl),
        jwtid: randomUUID(),
      }),
    );
  }

  issueService(clientId: string): Promise<{ token: string; expiresInSeconds: number }> {
    const expiresInSeconds = durationToSeconds(this.serviceTtl);
    const token = sign({ typ: 'service' }, this.privateKey, {
      algorithm: 'RS256',
      keyid: this.kid,
      subject: clientId,
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: expiresInSeconds,
    });
    return Promise.resolve({ token, expiresInSeconds });
  }

  signingKeys(): SigningKeyView[] {
    return [{ kid: this.kid, algorithm: 'RS256', publicKeyPem: this.publicKeyPem }];
  }
}

/** Refresh token opaco de 256 bits; en la base solo se guarda su SHA-256. */
export class OpaqueRefreshTokenCodec implements RefreshTokenCodec {
  generate(): string {
    return randomBytes(32).toString('base64url');
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

/**
 * Clientes de servicio declarados en SERVICE_CLIENTS como
 * "client-id:sha256hex,otro-id:sha256hex". Los secretos son aleatorios de alta
 * entropia, por eso basta SHA-256; la comparacion es de tiempo constante.
 */
export class EnvServiceClientRegistry implements ServiceClientRegistry {
  private readonly digests: ReadonlyMap<string, Buffer>;

  constructor(spec: string) {
    const entries = new Map<string, Buffer>();
    for (const part of spec.split(',').map((item) => item.trim()).filter(Boolean)) {
      const [clientId, digest] = part.split(':');
      if (!clientId || !digest || !/^[0-9a-f]{64}$/i.test(digest)) {
        throw new Error(`SERVICE_CLIENTS invalido cerca de "${clientId ?? part}"`);
      }
      entries.set(clientId, Buffer.from(digest, 'hex'));
    }
    this.digests = entries;
  }

  verify(clientId: string, clientSecret: string): boolean {
    const expected = this.digests.get(clientId);
    const actual = createHash('sha256').update(clientSecret).digest();
    if (!expected) {
      timingSafeEqual(actual, actual);
      return false;
    }
    return timingSafeEqual(expected, actual);
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
