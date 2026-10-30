import type { PrismaClient } from '../../generated/prisma';
import type { RefreshSession } from '../domain/refresh-session';
import type { SessionStore } from '../application/ports';

/** Sesiones de refresh en identity.refresh_sessions. */
export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(session: RefreshSession): Promise<void> {
    await this.prisma.refreshSession.create({
      data: {
        tokenHash: session.tokenHash,
        userId: session.userId,
        familyId: session.familyId,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
      },
    });
  }

  async findByHash(tokenHash: string): Promise<RefreshSession | null> {
    const row = await this.prisma.refreshSession.findUnique({ where: { tokenHash } });
    return row
      ? { userId: row.userId, tokenHash: row.tokenHash, familyId: row.familyId, expiresAt: row.expiresAt, revokedAt: row.revokedAt }
      : null;
  }

  async revokeIfActive(tokenHash: string, replacedByHash: string, at: Date): Promise<boolean> {
    // Un UPDATE condicionado es atomico: de dos rotaciones simultaneas solo una
    // ve revoked_at nulo.
    const { count } = await this.prisma.refreshSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: at, replacedByHash },
    });
    return count === 1;
  }

  async revokeFamily(familyId: string, at: Date): Promise<void> {
    await this.prisma.refreshSession.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: at } });
  }

  async deleteExpired(before: Date, limit: number): Promise<number> {
    // DELETE no admite LIMIT: se acota con una subconsulta sobre el indice de expires_at.
    return this.prisma.$executeRaw`
      DELETE FROM refresh_sessions
      WHERE token_hash IN (
        SELECT token_hash FROM refresh_sessions WHERE expires_at < ${before} LIMIT ${limit}
      )`;
  }
}
