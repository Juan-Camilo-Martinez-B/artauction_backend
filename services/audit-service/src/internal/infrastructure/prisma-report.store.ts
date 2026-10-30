import type { PrismaClient } from '../../generated/prisma';
import type { ReportStore, ReviewFinding } from '../application/ports';
import { isAssessment, isRecord } from './json-documents';

/** Valor de cada evidencia del expediente, por codigo. */
function evidenceValues(dossier: unknown): Map<string, string> {
  const evidence = isRecord(dossier) && Array.isArray(dossier['evidence']) ? dossier['evidence'] : [];
  return new Map(
    evidence.flatMap((item: unknown) =>
      isRecord(item) && typeof item['code'] === 'string' && typeof item['value'] === 'string' ? [[item['code'], item['value']] as const] : [],
    ),
  );
}

/** Cada hallazgo con el valor de las evidencias que cita, tomado del expediente. */
function resolvedFindings(assessment: unknown, dossier: unknown): ReviewFinding[] {
  if (!isAssessment(assessment)) {
    return [];
  }
  const values = evidenceValues(dossier);
  return assessment.findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    evidence: finding.evidence.map((code) => ({ code, value: values.get(code) ?? 'sin dato' })),
  }));
}

/** Informes completos en audit.reports, con la misma llave que su resumen. */
export class PrismaReportStore implements ReportStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findings(summaryIds: readonly string[]): Promise<Map<string, ReviewFinding[]>> {
    const rows = await this.prisma.auditReport.findMany({
      where: { summaryId: { in: [...summaryIds] } },
      select: { summaryId: true, assessment: true, dossier: true },
    });
    return new Map(rows.map((row) => [row.summaryId, resolvedFindings(row.assessment, row.dossier)]));
  }
}
