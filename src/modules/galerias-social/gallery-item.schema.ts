import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'gallery_items', versionKey: false })
export class GalleryItem {
  @Prop({ required: true, index: true })
  ownerId!: string;

  @Prop({ type: String, default: null })
  lotId!: string | null;

  @Prop({ required: true, enum: ['PROPIA', 'GANADA', 'GRATUITA'] })
  source!: 'PROPIA' | 'GANADA' | 'GRATUITA';

  @Prop({ required: true, enum: ['PUBLIC', 'PRIVATE'], default: 'PRIVATE' })
  visibility!: 'PUBLIC' | 'PRIVATE';

  @Prop({ required: true })
  title!: string;

  @Prop({ type: String, default: null })
  artistName!: string | null;

  @Prop({ type: [String], default: [] })
  imageKeys!: string[];

  @Prop({ required: true })
  acquiredAt!: Date;
}

export type GalleryItemDocument = HydratedDocument<GalleryItem>;
export const GalleryItemSchema = SchemaFactory.createForClass(GalleryItem);
