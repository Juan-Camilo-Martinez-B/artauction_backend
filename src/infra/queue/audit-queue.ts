import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { ENV, type Environment } from '../../common/config/environment';

export const AUDIT_QUEUE = 'audit-lot';
export const AUDIT_RETRY_LIMIT = 5;

export interface AuditJob {
  lotId: string;
}

@Injectable()
export class AuditQueue implements OnModuleDestroy {
  private boss: PgBoss | null = null;

  constructor(@Inject(ENV) private readonly env: Environment) {}

  async enqueue(lotId: string): Promise<void> {
    const boss = await this.client();
    await boss.send(AUDIT_QUEUE, { lotId } satisfies AuditJob, {
      retryLimit: AUDIT_RETRY_LIMIT,
      retryDelay: 10,
      retryBackoff: true,
      retryDelayMax: 300,
    });
  }

  async work(handler: (job: { data: AuditJob; retryCount: number }) => Promise<void>): Promise<void> {
    const boss = await this.client();
    await boss.work<AuditJob>(AUDIT_QUEUE, { localConcurrency: 1, batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        await handler({ data: job.data, retryCount: job.retryCount });
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop();
  }

  private async client(): Promise<PgBoss> {
    if (this.boss) {
      return this.boss;
    }
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({
      connectionString: this.env.DATABASE_URL,
      schema: this.env.PGBOSS_SCHEMA,
    });
    await boss.start();
    await boss.createQueue(AUDIT_QUEUE, {
      retryLimit: AUDIT_RETRY_LIMIT,
      retryDelay: 10,
      retryBackoff: true,
      retryDelayMax: 300,
    });
    this.boss = boss;
    return boss;
  }
}
