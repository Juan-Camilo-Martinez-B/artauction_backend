import { ObjectId, type Collection, type MongoClient } from 'mongodb';
import type { Finding } from '../domain/dossier';
import type { AuditReport, ReportStore, ReviewFinding } from '../application/ports';

type ReportDocument = Omit<AuditReport, 'id'> & { _id: string | ObjectId; summaryId?: string };
/** Lo que realmente puede traer un documento: los del monolito no tienen assessment ni dossier. */
type StoredReport = Omit<ReportDocument, 'assessment' | 'dossier'> & Partial<Pick<ReportDocument, 'assessment' | 'dossier'>> & LegacyFields;

/** Informe del monolito (anterior a F7): hallazgos sueltos, sin expediente. */
interface LegacyFields {
  findings?: unknown;
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function severityOf(value: unknown): Finding['severity'] {
  return value === 'CRITICAL' || value === 'WARNING' ? value : 'INFO';
}

function legacyFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    return [
      {
        code: typeof record['code'] === 'string' ? record['code'] : 'NOTE',
        severity: severityOf(record['severity']),
        message: typeof record['message'] === 'string' ? record['message'] : '',
        evidence: [],
      },
    ];
  });
}

/** Cada hallazgo con el valor de las evidencias que cita, tomado del expediente. */
function resolvedFindings(document: StoredReport): ReviewFinding[] {
  const findings = document.assessment?.findings;
  if (!findings) {
    return legacyFindings(document.findings);
  }
  const values = new Map((document.dossier?.evidence ?? []).map((item) => [item.code, item.value]));
  return findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    evidence: finding.evidence.map((code) => ({ code, value: values.get(code) ?? 'sin dato' })),
  }));
}

/**
 * Informes completos en la base Mongo propia de audit-service
 * (artauction_audit). El _id es el id del resumen en Postgres, asi un
 * reintento reemplaza el mismo documento en lugar de duplicarlo. Los informes
 * migrados del monolito conservan su ObjectId.
 */
export class MongoReportStore implements ReportStore {
  private readonly reports: Collection<ReportDocument>;

  constructor(client: MongoClient, database: string) {
    this.reports = client.db(database).collection<ReportDocument>('audit_reports');
  }

  async save(report: AuditReport): Promise<void> {
    const { id, ...rest } = report;
    // summaryId repite el _id porque artauction_bd lo indexa como unico: sin el
    // campo, todos los informes valdrian null y desde el segundo chocarian.
    await this.reports.replaceOne({ _id: id }, { ...rest, summaryId: id }, { upsert: true });
  }

  async findings(reportIds: readonly string[]): Promise<Map<string, ReviewFinding[]>> {
    const ids = reportIds.flatMap((id) => (OBJECT_ID.test(id) ? [id, new ObjectId(id)] : [id]));
    const documents = (await this.reports.find({ _id: { $in: ids } }).toArray()) as StoredReport[];
    return new Map(documents.map((document) => [String(document._id), resolvedFindings(document)]));
  }
}
