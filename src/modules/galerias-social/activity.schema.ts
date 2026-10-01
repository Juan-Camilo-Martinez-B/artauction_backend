import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'activity_feed', versionKey: false })
export class Activity {
  @Prop({ required: true, index: true })
  actorId!: string;

  @Prop({ required: true, enum: ['PUBLISH', 'BID', 'WIN', 'FOLLOW', 'AUDIT'] })
  verb!: 'PUBLISH' | 'BID' | 'WIN' | 'FOLLOW' | 'AUDIT';

  @Prop({ required: true, enum: ['LOT', 'AUCTION', 'USER', 'AUDIT'] })
  objectType!: 'LOT' | 'AUCTION' | 'USER' | 'AUDIT';

  @Prop({ required: true })
  objectId!: string;

  @Prop({ required: true, enum: ['PUBLIC', 'PRIVATE'] })
  visibility!: 'PUBLIC' | 'PRIVATE';

  @Prop({ required: true })
  summary!: string;

  @Prop({ required: true, default: () => new Date() })
  createdAt!: Date;
}

export type ActivityDocument = HydratedDocument<Activity>;
export const ActivitySchema = SchemaFactory.createForClass(Activity);
