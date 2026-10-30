import { createHash } from 'node:crypto';
import { DomainError } from '@artauction/platform';
import type { Account, Role } from '../src/internal/domain/account';
import type { RefreshSession } from '../src/internal/domain/refresh-session';
import type {
  AccessClaims,
  AccountRepository,
  PasswordHasher,
  RefreshTokenCodec,
  SessionStore,
  TokenIssuer,
} from '../src/internal/application/ports';
import { SessionIssuer } from '../src/internal/application/session-issuer';
import {
  GetPublicProfile,
  IssueServiceToken,
  Login,
  PurgeExpiredSessions,
  RegisterAccount,
  RotateRefreshSession,
  SESSION_RETENTION_MS,
  UpdateProfile,
} from '../src/internal/application/use-cases';
import { EnvServiceClientRegistry } from '../src/internal/infrastructure/crypto-adapters';

class MemoryAccounts implements AccountRepository {
  readonly rows = new Map<string, Account>();
  private seq = 0;

  findByEmail(email: string): Promise<Account | null> {
    return Promise.resolve([...this.rows.values()].find((row) => row.email === email) ?? null);
  }

  findById(id: string): Promise<Account | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  async create(input: { email: string; passwordHash: string; displayName: string; role: Role }): Promise<Account | null> {
    if (await this.findByEmail(input.email)) {
      return null;
    }
    this.seq += 1;
    const account: Account = { id: `u${String(this.seq)}`, profileVisibility: 'PUBLIC', avatarUrl: null, ...input };
    this.rows.set(account.id, account);
    return account;
  }

  updateProfile(id: string, patch: { displayName: string; avatarUrl?: string | null }): Promise<Account | null> {
    const row = this.rows.get(id);
    if (!row) {
      return Promise.resolve(null);
    }
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
}

class PlainHasher implements PasswordHasher {
  readonly verified: string[] = [];
  readonly decoyHash = Promise.resolve('hash:decoy');

  hash(password: string): Promise<string> {
    return Promise.resolve(`hash:${password}`);
  }

  verify(hash: string, password: string): Promise<boolean> {
    this.verified.push(hash);
    return Promise.resolve(hash === `hash:${password}`);
  }
}

class MemorySessions implements SessionStore {
  readonly rows = new Map<string, RefreshSession>();

  create(session: RefreshSession): Promise<void> {
    this.rows.set(session.tokenHash, { ...session });
    return Promise.resolve();
  }

  findByHash(tokenHash: string): Promise<RefreshSession | null> {
    const row = this.rows.get(tokenHash);
    return Promise.resolve(row ? { ...row } : null);
  }

  revokeIfActive(tokenHash: string, _replacedByHash: string, at: Date): Promise<boolean> {
    const row = this.rows.get(tokenHash);
    if (!row || row.revokedAt !== null) {
      return Promise.resolve(false);
    }
    row.revokedAt = at;
    return Promise.resolve(true);
  }

  revokeFamily(familyId: string, at: Date): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.familyId === familyId && row.revokedAt === null) {
        row.revokedAt = at;
      }
    }
    return Promise.resolve();
  }

  deleteExpired(before: Date, limit: number): Promise<number> {
    const expired = [...this.rows.values()].filter((row) => row.expiresAt < before).slice(0, limit);
    for (const row of expired) {
      this.rows.delete(row.tokenHash);
    }
    return Promise.resolve(expired.length);
  }
}

class CountingCodec implements RefreshTokenCodec {
  private seq = 0;

  generate(): string {
    this.seq += 1;
    return `refresh-token-number-${String(this.seq).padStart(4, '0')}`;
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

const tokens: TokenIssuer = {
  accessTtl: '15m',
  issueAccess: (claims: AccessClaims) => Promise.resolve(`access:${claims.userId}:${claims.role}`),
  issueService: (clientId: string) => Promise.resolve({ token: `service:${clientId}`, expiresInSeconds: 300 }),
  signingKeys: () => [],
};

function setup(now = new Date('2026-10-27T12:00:00Z')) {
  const accounts = new MemoryAccounts();
  const hasher = new PlainHasher();
  const store = new MemorySessions();
  const codec = new CountingCodec();
  const clock = { now: () => now };
  let family = 0;
  const ids = { next: () => `family-${String((family += 1))}` };
  const sessions = new SessionIssuer(tokens, codec, store, ids, clock, 7 * 86_400_000);
  return {
    accounts,
    hasher,
    store,
    register: new RegisterAccount(accounts, hasher),
    login: new Login(accounts, hasher, sessions),
    rotate: new RotateRefreshSession(accounts, store, codec, sessions, clock),
  };
}

async function expectKind(promise: Promise<unknown>, kind: DomainError['kind']): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).kind).toBe(kind);
}

describe('registro', () => {
  it('normaliza el correo y rechaza el duplicado', async () => {
    const { register } = setup();
    const account = await register.execute({ email: ' Leo@ArtAuction.Local ', password: 'DevPassword!234', displayName: 'Leo' });
    expect(account.email).toBe('leo@artauction.local');
    expect(account.role).toBe('USER');
    await expectKind(register.execute({ email: 'leo@artauction.local', password: 'DevPassword!234', displayName: 'Leo' }), 'CONFLICT');
  });

  it('no deja registrarse como ADMIN ni con una contrasena corta', async () => {
    const { register } = setup();
    await expectKind(register.execute({ email: 'a@b.co', password: 'DevPassword!234', displayName: 'Ana', role: 'ADMIN' }), 'PERMISSION_DENIED');
    await expectKind(register.execute({ email: 'a@b.co', password: 'corta', displayName: 'Ana' }), 'INVALID_ARGUMENT');
  });
});

describe('login', () => {
  it('emite un par de tokens con credenciales correctas', async () => {
    const { register, login } = setup();
    await register.execute({ email: 'leo@artauction.local', password: 'DevPassword!234', displayName: 'Leo', role: 'SELLER' });
    const pair = await login.execute({ email: 'LEO@artauction.local', password: 'DevPassword!234' });
    expect(pair.accessToken).toBe('access:u1:SELLER');
    expect(pair.expiresIn).toBe('15m');
  });

  it('verifica contra el hash senuelo cuando el correo no existe', async () => {
    const { login, hasher } = setup();
    await expectKind(login.execute({ email: 'nadie@artauction.local', password: 'DevPassword!234' }), 'UNAUTHENTICATED');
    expect(hasher.verified).toEqual(['hash:decoy']);
  });
});

describe('rotacion de refresh', () => {
  async function loggedIn() {
    const context = setup();
    await context.register.execute({ email: 'leo@artauction.local', password: 'DevPassword!234', displayName: 'Leo' });
    const pair = await context.login.execute({ email: 'leo@artauction.local', password: 'DevPassword!234' });
    return { ...context, pair };
  }

  it('rota el token y revoca el anterior', async () => {
    const { rotate, pair } = await loggedIn();
    const next = await rotate.execute(pair.refreshToken);
    expect(next.refreshToken).not.toBe(pair.refreshToken);
    await expectKind(rotate.execute(pair.refreshToken), 'UNAUTHENTICATED');
  });

  it('revoca toda la familia cuando un token revocado se reutiliza', async () => {
    const { rotate, pair } = await loggedIn();
    const next = await rotate.execute(pair.refreshToken);
    await expectKind(rotate.execute(pair.refreshToken), 'UNAUTHENTICATED');
    await expectKind(rotate.execute(next.refreshToken), 'UNAUTHENTICATED');
  });

  it('solo una de dos rotaciones simultaneas gana', async () => {
    const { rotate, pair } = await loggedIn();
    const results = await Promise.allSettled([rotate.execute(pair.refreshToken), rotate.execute(pair.refreshToken)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('barrido de sesiones', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const session = (tokenHash: string, expiresAt: Date): RefreshSession => ({
    userId: 'user-1',
    tokenHash,
    familyId: 'family-1',
    expiresAt,
    revokedAt: null,
  });

  it('borra solo las sesiones vencidas hace mas de un dia', async () => {
    const store = new MemorySessions();
    await store.create(session('vencida-hace-dos-dias', new Date(now.getTime() - 2 * SESSION_RETENTION_MS)));
    await store.create(session('vencida-hace-una-hora', new Date(now.getTime() - 3_600_000)));
    await store.create(session('vigente', new Date(now.getTime() + 3_600_000)));
    const removed = await new PurgeExpiredSessions(store, { now: () => now }).execute();
    expect(removed).toBe(1);
    expect([...store.rows.keys()].sort()).toEqual(['vencida-hace-una-hora', 'vigente']);
  });

  it('respeta el limite de cada barrido', async () => {
    const store = new MemorySessions();
    for (const name of ['a', 'b', 'c']) {
      await store.create(session(name, new Date(now.getTime() - 2 * SESSION_RETENTION_MS)));
    }
    expect(await new PurgeExpiredSessions(store, { now: () => now }).execute(2)).toBe(2);
    expect(store.rows.size).toBe(1);
  });
});

describe('perfil', () => {
  it('acepta un avatar https y rechaza otros esquemas', async () => {
    const { register, accounts } = setup();
    const account = await register.execute({ email: 'leo@artauction.local', password: 'DevPassword!234', displayName: 'Leo' });
    const update = new UpdateProfile(accounts);
    const updated = await update.execute({ userId: account.userId, displayName: 'Leo P', avatarUrl: 'https://img.example/leo.png' });
    expect(updated.avatarUrl).toBe('https://img.example/leo.png');
    await expectKind(update.execute({ userId: account.userId, displayName: 'Leo', avatarUrl: 'javascript:alert(1)' }), 'INVALID_ARGUMENT');
    expect((await update.execute({ userId: account.userId, displayName: 'Leo', avatarUrl: '' })).avatarUrl).toBeNull();
  });

  it('oculta el avatar de un perfil privado', async () => {
    const { register, accounts } = setup();
    const account = await register.execute({ email: 'nora@artauction.local', password: 'DevPassword!234', displayName: 'Nora' });
    const row = accounts.rows.get(account.userId);
    if (row) {
      accounts.rows.set(account.userId, { ...row, profileVisibility: 'PRIVATE', avatarUrl: 'https://img.example/n.png' });
    }
    const profile = await new GetPublicProfile(accounts).execute(account.userId);
    expect(profile.avatarUrl).toBeNull();
    expect(profile.visibility).toBe('PRIVATE');
  });
});

describe('tokens de servicio', () => {
  const secret = 'secreto-de-servicio-de-alta-entropia';
  const digest = createHash('sha256').update(secret).digest('hex');
  const issue = new IssueServiceToken(new EnvServiceClientRegistry(`catalog-service:${digest}`), tokens);

  it('emite token solo con el secreto correcto', async () => {
    await expect(issue.execute({ clientId: 'catalog-service', clientSecret: secret })).resolves.toEqual({
      token: 'service:catalog-service',
      expiresInSeconds: 300,
    });
    await expectKind(issue.execute({ clientId: 'catalog-service', clientSecret: 'otro' }), 'UNAUTHENTICATED');
    await expectKind(issue.execute({ clientId: 'desconocido', clientSecret: secret }), 'UNAUTHENTICATED');
  });

  it('rechaza una configuracion mal formada', () => {
    expect(() => new EnvServiceClientRegistry('catalog-service:no-es-hex')).toThrow(/SERVICE_CLIENTS/);
  });
});
