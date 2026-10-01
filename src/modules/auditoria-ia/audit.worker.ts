import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ENV, type Environment } from '../../common/config/environment';
import { OUTCOME_NOTIFIER, type OutcomeNotifier } from '../../common/outcomes';
import { AI_AUDIT_PORT, type AiAuditPort } from '../../infra/ai/ai-audit.port';
import { CircuitBreaker } from '../../infra/ai/circuit-breaker';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { AUDIT_RETRY_LIMIT, AuditQueue } from '../../infra/queue/audit-queue';
import { AuditReport } from './audit-report.schema';
import { decideVerdict } from './score';

@Injectable()
export class AuditWorker implements OnModuleInit {
  private readonly breaker = new CircuitBreaker();

  constructor(
    private readonly queue: AuditQueue,
    private readonly prisma: PrismaService,
    @Inject(AI_AUDIT_PORT) private readonly ai: AiAuditPort,
    @InjectModel(AuditReport.name) private readonly reports: Model<AuditReport>,
    @Inject(ENV) private readonly env: Environment,
    @Optional() @Inject(OUTCOME_NOTIFIER) private readonly notifier?: OutcomeNotifier,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') {
      return;
    }
    void this.queue.work((job) => this.handle(job));
  }

  async handle(job: { data: { lotId: string }; retryCount: number }): Promise<void> {
    try {
      this.breaker.assertClosed(Date.now());
      await this.process(job.data.lotId);
      this.breaker.recordSuccess();
    } catch (error) {
      this.breaker.recordFailure(Date.now());
      if (job.retryCount + 1 >= AUDIT_RETRY_LIMIT) {
        await this.markManual(job.data.lotId);
        return;
      }
      throw error;
    }
  }

  async process(lotId: string): Promise<void> {
    const lot = await this.prisma.lot.findUnique({
      where: { id: lotId },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    if (!lot || lot.status !== 'PENDIENTE_AUDITORIA') {
      return;
    }
    const input = {
      lotId: lot.id,
      title: lot.title,
      description: lot.description,
      materials: lot.materials,
      creationYear: lot.creationYear,
      imageHashes: lot.images.flatMap((image) => (image.perceptualHash ? [image.perceptualHash] : [])),
    };
    const result = await this.ai.audit(input);
    const critical = result.critical || result.findings.some((finding) => finding.severity === 'CRITICAL');
    const verdict = decideVerdict(result.score, critical);
    const summaryId = randomUUID();
    const report = await this.reports.create({
      lotId: lot.id,
      summaryId,
      model: result.model,
      promptVersion: result.promptVersion,
      input,
      findings: result.findings,
      authenticityScore: result.score,
      suggestedPriceMin: result.priceMin,
      suggestedPriceMax: result.priceMax,
      createdAt: new Date(),
    });
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.lot.updateMany({
          where: { id: lot.id, status: 'PENDIENTE_AUDITORIA' },
          data: {
            status: verdict,
            visibility: verdict === 'APROBADO' ? 'PUBLIC' : 'PRIVATE',
            authenticityScore: result.score,
            suggestedPriceMin: result.priceMin.toFixed(2),
            suggestedPriceMax: result.priceMax.toFixed(2),
          },
        });
        if (changed.count !== 1) {
          return false;
        }
        await tx.auditSummary.create({
          data: {
            id: summaryId,
            lotId: lot.id,
            score: result.score,
            priceMin: result.priceMin.toFixed(2),
            priceMax: result.priceMax.toFixed(2),
            verdict,
            hasCriticalInconsistency: critical,
            mongoReportId: String(report._id),
            modelName: result.model,
            promptVersion: result.promptVersion,
          },
        });
        return true;
      });
      if (!updated) {
        await this.reports.deleteOne({ summaryId }).exec();
        return;
      }
    } catch (error) {
      await this.reports.deleteOne({ summaryId }).exec();
      throw error;
    }
    await this.notifier?.auditFinished({ lotId: lot.id, sellerId: lot.sellerId, verdict });
  }

  async markManual(lotId: string): Promise<void> {
    await this.prisma.lot.updateMany({
      where: { id: lotId, status: 'PENDIENTE_AUDITORIA' },
      data: { status: 'REVISION_MANUAL', visibility: 'PRIVATE' },
    });
  }
}
