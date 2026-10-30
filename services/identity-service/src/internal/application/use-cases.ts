import { DomainError } from '@artauction/platform';
import {
  assertPasswordPolicy,
  normalizeDisplayName,
  normalizeEmail,
  parseAvatarUrl,
  registrationRole,
  type Role,
} from '../domain/account';
import { assessRefresh } from '../domain/refresh-session';
import type {
  AccountRepository,
  Clock,
  PasswordHasher,
  RefreshTokenCodec,
  ServiceClientRegistry,
  SessionStore,
  SigningKeyView,
  TokenIssuer,
} from './ports';
import type { SessionIssuer } from './session-issuer';
import { toAccountView, type AccountView, type PublicProfileView, type TokenPair } from './views';

const INVALID_CREDENTIALS = 'Credenciales invalidas';
const INVALID_REFRESH = 'Refresh token invalido';

export class RegisterAccount {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(input: { email: string; password: string; displayName: string; role?: Role }): Promise<AccountView> {
    const email = normalizeEmail(input.email);
    assertPasswordPolicy(input.password);
    const displayName = normalizeDisplayName(input.displayName);
    const role = registrationRole(input.role);
    const created = await this.accounts.create({
      email,
      passwordHash: await this.hasher.hash(input.password),
      displayName,
      role,
    });
    if (!created) {
      throw DomainError.conflict('El correo ya esta registrado');
    }
    return toAccountView(created);
  }
}

export class Login {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionIssuer,
  ) {}

  async execute(input: { email: string; password: string }): Promise<TokenPair> {
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      throw DomainError.unauthenticated(INVALID_CREDENTIALS);
    }
    const account = await this.accounts.findByEmail(email);
    // Sin cuenta se verifica contra un hash señuelo: la respuesta tarda lo mismo
    // y no revela que correos existen.
    const valid = await this.hasher.verify(account?.passwordHash ?? (await this.hasher.decoyHash), input.password);
    if (!account || !valid) {
      throw DomainError.unauthenticated(INVALID_CREDENTIALS);
    }
    const { pair } = await this.sessions.issue({ userId: account.id, email: account.email, role: account.role });
    return pair;
  }
}

export class RotateRefreshSession {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly store: SessionStore,
    private readonly codec: RefreshTokenCodec,
    private readonly sessions: SessionIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(refreshToken: string): Promise<TokenPair> {
    const now = this.clock.now();
    const current = await this.store.findByHash(this.codec.hash(refreshToken));
    if (!current) {
      throw DomainError.unauthenticated(INVALID_REFRESH);
    }
    const assessment = assessRefresh(current, now);
    if (assessment === 'REUSED') {
      await this.store.revokeFamily(current.familyId, now);
      throw DomainError.unauthenticated('Refresh token reutilizado');
    }
    if (assessment === 'EXPIRED') {
      throw DomainError.unauthenticated(INVALID_REFRESH);
    }
    const account = await this.accounts.findById(current.userId);
    if (!account) {
      throw DomainError.unauthenticated(INVALID_REFRESH);
    }
    const { pair, refreshHash } = await this.sessions.issue(
      { userId: account.id, email: account.email, role: account.role },
      current.familyId,
    );
    const won = await this.store.revokeIfActive(current.tokenHash, refreshHash, now);
    if (!won) {
      // Otra peticion uso el mismo token a la vez: se trata como reuso.
      await this.store.revokeFamily(current.familyId, now);
      throw DomainError.unauthenticated('Refresh token reutilizado');
    }
    return pair;
  }
}

export class GetAccount {
  constructor(private readonly accounts: AccountRepository) {}

  async execute(userId: string): Promise<AccountView> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw DomainError.unauthenticated('La sesion no es valida');
    }
    return toAccountView(account);
  }
}

export class UpdateProfile {
  constructor(private readonly accounts: AccountRepository) {}

  async execute(input: { userId: string; displayName: string; avatarUrl?: string }): Promise<AccountView> {
    const patch: { displayName: string; avatarUrl?: string | null } = {
      displayName: normalizeDisplayName(input.displayName),
    };
    if (input.avatarUrl !== undefined) {
      patch.avatarUrl = parseAvatarUrl(input.avatarUrl);
    }
    const updated = await this.accounts.updateProfile(input.userId, patch);
    if (!updated) {
      throw DomainError.notFound('La cuenta no existe');
    }
    return toAccountView(updated);
  }
}

export class GetPublicProfile {
  constructor(private readonly accounts: AccountRepository) {}

  async execute(userId: string): Promise<PublicProfileView> {
    const account = await this.accounts.findById(userId);
    if (!account) {
      throw DomainError.notFound('Usuario no encontrado');
    }
    return {
      userId: account.id,
      displayName: account.displayName,
      avatarUrl: account.profileVisibility === 'PUBLIC' ? account.avatarUrl : null,
      visibility: account.profileVisibility,
    };
  }
}

export class IssueServiceToken {
  constructor(
    private readonly clients: ServiceClientRegistry,
    private readonly tokens: TokenIssuer,
  ) {}

  async execute(input: { clientId: string; clientSecret: string }): Promise<{ token: string; expiresInSeconds: number }> {
    if (!this.clients.verify(input.clientId, input.clientSecret)) {
      throw DomainError.unauthenticated('Credenciales de servicio invalidas');
    }
    return this.tokens.issueService(input.clientId);
  }
}

/** Una sesion vencida se conserva un dia, como hacia el indice TTL de Mongo. */
export const SESSION_RETENTION_MS = 86_400_000;

/**
 * Borra las sesiones de refresh vencidas hace mas de un dia. Una sesion
 * vencida ya no rota (assessRefresh la rechaza), asi que borrarla no cambia
 * ninguna respuesta; solo evita que la tabla crezca sin limite.
 */
export class PurgeExpiredSessions {
  constructor(
    private readonly store: SessionStore,
    private readonly clock: Clock,
  ) {}

  async execute(limit = 1_000): Promise<number> {
    return this.store.deleteExpired(new Date(this.clock.now().getTime() - SESSION_RETENTION_MS), limit);
  }
}

export class GetSigningKeys {
  constructor(private readonly tokens: TokenIssuer) {}

  execute(): SigningKeyView[] {
    return this.tokens.signingKeys();
  }
}
