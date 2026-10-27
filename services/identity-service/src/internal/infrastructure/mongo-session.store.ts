import { Schema, type Connection, type Model } from 'mongoose';
import type { RefreshSession } from '../domain/refresh-session';
import type { SessionStore } from '../application/ports';

interface SessionDocument extends RefreshSession {
  replacedByHash: string | null;
}

const sessionSchema = new Schema<SessionDocument>(
  {
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
  },
  { collection: 'refresh_sessions', versionKey: false },
);

// Mongo borra solo las sesiones vencidas un dia despues de caducar.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export class MongoSessionStore implements SessionStore {
  private readonly sessions: Model<SessionDocument>;

  constructor(connection: Connection) {
    this.sessions = connection.model<SessionDocument>('RefreshSession', sessionSchema);
  }

  async create(session: RefreshSession): Promise<void> {
    await this.sessions.create({ ...session, replacedByHash: null });
  }

  async findByHash(tokenHash: string): Promise<RefreshSession | null> {
    const found = await this.sessions.findOne({ tokenHash }).lean().exec();
    if (!found) {
      return null;
    }
    return {
      userId: found.userId,
      tokenHash: found.tokenHash,
      familyId: found.familyId,
      expiresAt: found.expiresAt,
      revokedAt: found.revokedAt,
    };
  }

  async revokeIfActive(tokenHash: string, replacedByHash: string, at: Date): Promise<boolean> {
    const updated = await this.sessions
      .findOneAndUpdate({ tokenHash, revokedAt: null }, { revokedAt: at, replacedByHash })
      .lean()
      .exec();
    return updated !== null;
  }

  async revokeFamily(familyId: string, at: Date): Promise<void> {
    await this.sessions.updateMany({ familyId, revokedAt: null }, { revokedAt: at }).exec();
  }
}
