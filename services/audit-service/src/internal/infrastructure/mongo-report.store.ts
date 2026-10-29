import type { Collection, MongoClient } from 'mongodb';
import type { AuditReport, ReportStore } from '../application/ports';

type ReportDocument = Omit<AuditReport, 'id'> & { _id: string };

/**
 * Informes completos en la base Mongo propia de audit-service
 * (artauction_audit). El _id es el id del resumen en Postgres, asi un
 * reintento reemplaza el mismo documento en lugar de duplicarlo.
 */
export class MongoReportStore implements ReportStore {
  private readonly reports: Collection<ReportDocument>;

  constructor(client: MongoClient, database: string) {
    this.reports = client.db(database).collection<ReportDocument>('audit_reports');
  }

  async save(report: AuditReport): Promise<void> {
    const { id, ...rest } = report;
    await this.reports.replaceOne({ _id: id }, rest, { upsert: true });
  }
}
