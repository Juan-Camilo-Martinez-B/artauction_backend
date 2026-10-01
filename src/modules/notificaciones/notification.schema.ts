import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'notifications', versionKey: false })
export class Notification {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, enum: ['AUDIT', 'AUCTION_CLOSED'] })
  kind!: 'AUDIT' | 'AUCTION_CLOSED';

  @Prop({ type: Object, required: true })
  payload!: Record<string, string | null>;

  @Prop({ required: true, default: () => new Date() })
  createdAt!: Date;

  @Prop({ type: Date, default: null })
  readAt!: Date | null;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
