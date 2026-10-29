import type { AccessClaims, Clock, IdGenerator, RefreshTokenCodec, SessionStore, TokenIssuer } from './ports';
import type { TokenPair } from './views';

/**
 * Emite un par access + refresh y registra la sesion de refresh. Lo comparten
 * el login y la rotacion para que ambos creen sesiones identicas.
 */
export class SessionIssuer {
  constructor(
    private readonly tokens: TokenIssuer,
    private readonly codec: RefreshTokenCodec,
    private readonly sessions: SessionStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly refreshTtlMs: number,
  ) {}

  async issue(claims: AccessClaims, familyId: string = this.ids.next()): Promise<{ pair: TokenPair; refreshHash: string }> {
    const refreshToken = this.codec.generate();
    const refreshHash = this.codec.hash(refreshToken);
    await this.sessions.create({
      userId: claims.userId,
      tokenHash: refreshHash,
      familyId,
      expiresAt: new Date(this.clock.now().getTime() + this.refreshTtlMs),
      revokedAt: null,
    });
    const accessToken = await this.tokens.issueAccess(claims);
    return { pair: { accessToken, refreshToken, expiresIn: this.tokens.accessTtl }, refreshHash };
  }
}
