import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ENV, type Environment } from '../../common/config/environment';
import { AI_AUDIT_PORT, type AiAuditPort } from '../../infra/ai/ai-audit.port';
import { FakeAiAuditAdapter } from '../../infra/ai/fake-ai-audit.adapter';
import { GeminiAiAuditAdapter } from '../../infra/ai/gemini-ai-audit.adapter';
import { AuditQueue } from '../../infra/queue/audit-queue';
import { AuditReport, AuditReportSchema } from './audit-report.schema';
import { AuditWorker } from './audit.worker';

@Module({
  imports: [MongooseModule.forFeature([{ name: AuditReport.name, schema: AuditReportSchema }])],
  providers: [
    AuditQueue,
    AuditWorker,
    FakeAiAuditAdapter,
    GeminiAiAuditAdapter,
    {
      provide: AI_AUDIT_PORT,
      inject: [ENV, FakeAiAuditAdapter, GeminiAiAuditAdapter],
      useFactory: (env: Environment, fake: FakeAiAuditAdapter, gemini: GeminiAiAuditAdapter): AiAuditPort =>
        env.geminiConfigured ? gemini : fake,
    },
  ],
  exports: [AuditWorker],
})
export class AuditoriaModule {}
