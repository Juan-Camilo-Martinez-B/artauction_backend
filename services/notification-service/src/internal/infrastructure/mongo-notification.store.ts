import type { Collection, Db, ObjectId } from 'mongodb';
import type { Notification } from '../domain/notification';
import type { NotificationStore } from '../application/use-cases';

// Los avisos migrados del monolito conservan su ObjectId; los nuevos usan el id
// determinista evento:destinatario.
type NotificationDocument = Omit<Notification, 'id'> & { _id: string | ObjectId };
type ProcessedEvent = { _id: string; type: string; processedAt: Date };

/** Avisos en la base Mongo propia de notification-service (artauction_notification). */
export class MongoNotificationStore implements NotificationStore {
  private readonly notifications: Collection<NotificationDocument>;
  private readonly processed: Collection<ProcessedEvent>;

  constructor(database: Db) {
    this.notifications = database.collection<NotificationDocument>('notifications');
    this.processed = database.collection<ProcessedEvent>('processed_events');
  }

  async saveAll(notifications: readonly Notification[]): Promise<void> {
    for (const { id, ...notification } of notifications) {
      await this.notifications.updateOne({ _id: id }, { $setOnInsert: notification }, { upsert: true });
    }
  }

  async latest(userId: string, limit: number): Promise<Notification[]> {
    const documents = await this.notifications.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray();
    return documents.map((document) => ({
      id: String(document._id),
      userId: document.userId,
      kind: document.kind,
      payload: document.payload,
      createdAt: document.createdAt,
      readAt: document.readAt,
    }));
  }

  async seen(eventId: string): Promise<boolean> {
    return (await this.processed.countDocuments({ _id: eventId }, { limit: 1 })) > 0;
  }

  async recordEvent(eventId: string, eventType: string): Promise<void> {
    await this.processed.updateOne({ _id: eventId }, { $setOnInsert: { type: eventType, processedAt: new Date() } }, { upsert: true });
  }
}
