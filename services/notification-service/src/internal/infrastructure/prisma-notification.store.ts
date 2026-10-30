import { recordInbox, sqlExecutorFrom } from '@artauction/platform';
import type { PrismaClient } from '../../generated/prisma';
import type { Notification } from '../domain/notification';
import type { NotificationStore } from '../application/use-cases';

const SCHEMA = 'notification';

/** El payload se guarda como JSONB; al leerlo solo se aceptan textos o nulos. */
function payloadOf(value: unknown): Notification['payload'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : null]),
  );
}

/** Avisos en notification.notifications y su inbox en notification.inbox. */
export class PrismaNotificationStore implements NotificationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async saveAll(notifications: readonly Notification[]): Promise<void> {
    if (notifications.length === 0) {
      return;
    }
    // ON CONFLICT DO NOTHING sobre el id determinista: un reintento no duplica.
    await this.prisma.notification.createMany({
      data: notifications.map((notification) => ({ ...notification })),
      skipDuplicates: true,
    });
  }

  async latest(userId: string, limit: number): Promise<Notification[]> {
    const rows = await this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      kind: row.kind as Notification['kind'],
      payload: payloadOf(row.payload),
      createdAt: row.createdAt,
      readAt: row.readAt,
    }));
  }

  async seen(eventId: string): Promise<boolean> {
    const rows = await sqlExecutorFrom(this.prisma).query<{ found: number }>(
      `SELECT 1 AS found FROM ${SCHEMA}.inbox WHERE event_id = $1`,
      eventId,
    );
    return rows.length > 0;
  }

  async recordEvent(eventId: string, eventType: string): Promise<void> {
    await recordInbox(sqlExecutorFrom(this.prisma), SCHEMA, eventId, eventType);
  }
}
