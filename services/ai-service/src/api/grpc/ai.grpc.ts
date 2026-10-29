import { aiV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { ArtworkDossier, Finding, Severity } from '../../internal/domain/assessment';
import type { AuditArtwork, DesignGallery } from '../../internal/application/use-cases';

const SEVERITY_FROM_PROTO: ReadonlyMap<aiV1.FindingSeverity, Severity> = new Map([
  [aiV1.FindingSeverity.FINDING_SEVERITY_INFO, 'INFO'],
  [aiV1.FindingSeverity.FINDING_SEVERITY_WARNING, 'WARNING'],
  [aiV1.FindingSeverity.FINDING_SEVERITY_CRITICAL, 'CRITICAL'],
]);

const SEVERITY_TO_PROTO: Readonly<Record<Severity, aiV1.FindingSeverity>> = {
  INFO: aiV1.FindingSeverity.FINDING_SEVERITY_INFO,
  WARNING: aiV1.FindingSeverity.FINDING_SEVERITY_WARNING,
  CRITICAL: aiV1.FindingSeverity.FINDING_SEVERITY_CRITICAL,
};

const MAX_EVIDENCE = 80;

function findingFromProto(finding: aiV1.Finding): Finding {
  return {
    code: finding.code,
    severity: SEVERITY_FROM_PROTO.get(finding.severity) ?? 'INFO',
    message: finding.message,
    evidence: finding.evidence,
  };
}

function dossierFromProto(request: aiV1.AuditArtworkRequest): ArtworkDossier {
  return {
    lotId: request.lotId,
    title: request.title,
    description: request.description,
    materials: request.materials,
    creationYear: request.creationYear ?? null,
    artistName: request.artistName ?? null,
    declaredDimensions: request.declaredDimensions,
    provenance: request.provenance,
    evidence: request.evidence.slice(0, MAX_EVIDENCE).map((item) => ({ code: item.code, value: item.value })),
    ruleFindings: request.ruleFindings.map(findingFromProto),
  };
}

/** Frontera gRPC de ai-service. Solo la llaman servicios internos. */
export function aiGrpcService(
  useCases: { audit: AuditArtwork; design: DesignGallery },
  callers: CallerResolver,
  logger: StructuredLogger,
): aiV1.AiServiceServer {
  return {
    auditArtwork: unary(logger, 'AuditArtwork', async (request, context) => {
      callers.service(context, ['audit-service']);
      const assessment = await useCases.audit.execute(dossierFromProto(request));
      return aiV1.AuditArtworkResponse.fromPartial({
        model: assessment.model,
        promptVersion: assessment.promptVersion,
        score: assessment.score,
        critical: assessment.critical,
        priceMin: assessment.priceMin,
        priceMax: assessment.priceMax,
        findings: assessment.findings.map((finding) => ({ ...finding, severity: SEVERITY_TO_PROTO[finding.severity] })),
      });
    }),

    // Hasta F8 la galeria vive en el monolito, que se identifica como gallery-service.
    designGallery: unary(logger, 'DesignGallery', async (request, context) => {
      callers.service(context, ['gallery-service']);
      const designed = await useCases.design.execute(request.preferences ?? {});
      return aiV1.DesignGalleryResponse.fromPartial(designed);
    }),
  };
}
