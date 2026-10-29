/**
 * Sesion de refresh opaca. Cada uso la rota: la sesion actual se revoca y nace
 * otra en la misma familia. Presentar una sesion ya revocada indica que el
 * token se robo o se copio, y se revoca toda la familia.
 */
export interface RefreshSession {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type RefreshAssessment = 'ACTIVE' | 'EXPIRED' | 'REUSED';

export function assessRefresh(session: RefreshSession, now: Date): RefreshAssessment {
  if (session.revokedAt !== null) {
    return 'REUSED';
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return 'ACTIVE';
}
