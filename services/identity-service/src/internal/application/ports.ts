import type { Account, Role } from '../domain/account';
import type { RefreshSession } from '../domain/refresh-session';

// Puertos que necesitan los casos de uso. Las implementaciones viven en
// infrastructure y se conectan en la raiz de composicion.

export interface AccountRepository {
  findByEmail(email: string): Promise<Account | null>;
  findById(id: string): Promise<Account | null>;
  /** Devuelve null si el correo ya existe. */
  create(input: { email: string; passwordHash: string; displayName: string; role: Role }): Promise<Account | null>;
  updateProfile(id: string, patch: { displayName: string; avatarUrl?: string | null }): Promise<Account | null>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /** Hash valido de una contrasena aleatoria, para igualar tiempos cuando el usuario no existe. */
  readonly decoyHash: Promise<string>;
}

export interface AccessClaims {
  userId: string;
  email: string;
  role: Role;
}

export interface SigningKeyView {
  kid: string;
  algorithm: string;
  publicKeyPem: string;
}

export interface TokenIssuer {
  readonly accessTtl: string;
  issueAccess(claims: AccessClaims): Promise<string>;
  issueService(clientId: string): Promise<{ token: string; expiresInSeconds: number }>;
  signingKeys(): SigningKeyView[];
}

export interface RefreshTokenCodec {
  generate(): string;
  hash(token: string): string;
}

export interface SessionStore {
  create(session: RefreshSession): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshSession | null>;
  /**
   * Revoca la sesion solo si sigue activa. Devuelve false si otra peticion la
   * revoco antes: dos refresh simultaneos con el mismo token no pueden ganar.
   */
  revokeIfActive(tokenHash: string, replacedByHash: string, at: Date): Promise<boolean>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  /** Borra hasta `limit` sesiones vencidas antes de `before`; devuelve cuantas. */
  deleteExpired(before: Date, limit: number): Promise<number>;
}

export interface ServiceClientRegistry {
  verify(clientId: string, clientSecret: string): boolean;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
