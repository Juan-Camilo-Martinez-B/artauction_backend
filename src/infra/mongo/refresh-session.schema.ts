import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'refresh_sessions', versionKey: false })
export class RefreshSession {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, unique: true })
  tokenHash!: string;

  @Prop({ required: true, index: true })
  familyId!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({ type: String, default: null })
  replacedByHash!: string | null;
}

export type RefreshSessionDocument = HydratedDocument<RefreshSession>;
export const RefreshSessionSchema = SchemaFactory.createForClass(RefreshSession);
