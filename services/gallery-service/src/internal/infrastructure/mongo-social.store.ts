import type { Collection, Db, ObjectId } from 'mongodb';
import type { Activity, GalleryItem } from '../domain/gallery';
import type { SocialStore } from '../application/ports';

// Los documentos migrados del monolito conservan su ObjectId; los nuevos usan
// un id determinista en texto para que repetir un evento no los duplique.
type Id = string | ObjectId;
type ItemDocument = GalleryItem & { _id: Id };
type ActivityDocument = Activity & { _id: Id };

function toItem(document: ItemDocument): GalleryItem {
  return {
    ownerId: document.ownerId,
    lotId: document.lotId,
    source: document.source,
    visibility: document.visibility,
    title: document.title,
    artistName: document.artistName,
    imageKeys: document.imageKeys,
    acquiredAt: document.acquiredAt,
  };
}

function toActivity(document: ActivityDocument): Activity {
  return {
    actorId: document.actorId,
    verb: document.verb,
    objectType: document.objectType,
    objectId: document.objectId,
    visibility: document.visibility,
    summary: document.summary,
    createdAt: document.createdAt,
  };
}

/** Galeria social en la base Mongo propia de gallery-service (artauction_gallery). */
export class MongoSocialStore implements SocialStore {
  private readonly items: Collection<ItemDocument>;
  private readonly activity: Collection<ActivityDocument>;

  constructor(database: Db) {
    this.items = database.collection<ItemDocument>('gallery_items');
    this.activity = database.collection<ActivityDocument>('activity_feed');
  }

  async upsertItem(id: string, item: GalleryItem): Promise<void> {
    await this.items.updateOne({ _id: id }, { $setOnInsert: item }, { upsert: true });
  }

  async itemsOf(ownerId: string): Promise<GalleryItem[]> {
    const documents = await this.items.find({ ownerId }).sort({ acquiredAt: -1 }).toArray();
    return documents.map(toItem);
  }

  async upsertActivity(id: string, activity: Activity): Promise<void> {
    await this.activity.updateOne({ _id: id }, { $setOnInsert: activity }, { upsert: true });
  }

  async feed(viewerId: string, limit: number): Promise<Activity[]> {
    const documents = await this.activity
      .find({ $or: [{ visibility: 'PUBLIC' }, { actorId: viewerId }] })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return documents.map(toActivity);
  }
}
