import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class AuditFinding {
  @Prop({ required: true })
  code!: string;

  @Prop({ required: true, enum: ['INFO', 'WARNING', 'CRITICAL'] })
  severity!: 'INFO' | 'WARNING' | 'CRITICAL';

  @Prop({ required: true })
  message!: string;
}

@Schema({ _id: false })
export class AuditInputDocument {
  @Prop({ required: true })
  title!: string;

  @Prop({ required: true })
  description!: string;

  @Prop({ required: true })
  materials!: string;

  @Prop({ type: Number, default: null })
  creationYear!: number | null;

  @Prop({ type: [String], default: [] })
  imageHashes!: string[];
}

@Schema({ collection: 'audit_reports', versionKey: false })
export class AuditReport {
  @Prop({ required: true, index: true })
  lotId!: string;

  @Prop({ required: true, unique: true })
  summaryId!: string;

  @Prop({ required: true })
  model!: string;

  @Prop({ required: true })
  promptVersion!: string;

  @Prop({ type: AuditInputDocument, required: true })
  input!: AuditInputDocument;

  @Prop({ type: [AuditFinding], default: [] })
  findings!: AuditFinding[];

  @Prop({ required: true, min: 0, max: 100 })
  authenticityScore!: number;

  @Prop({ required: true, min: 0 })
  suggestedPriceMin!: number;

  @Prop({ required: true, min: 0 })
  suggestedPriceMax!: number;

  @Prop({ required: true, default: () => new Date() })
  createdAt!: Date;
}

export type AuditReportDocument = HydratedDocument<AuditReport>;
export const AuditReportSchema = SchemaFactory.createForClass(AuditReport);
