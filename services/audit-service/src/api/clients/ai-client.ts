import { aiV1 } from '@artauction/contracts';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import type { Dossier, Finding, Severity } from '../../internal/domain/dossier';
import type { Assessment } from '../../internal/domain/verdict';
import type { AiPort } from '../../internal/application/ports';

const SEVERITY_TO_PROTO: Readonly<Record<Severity, aiV1.FindingSeverity>> = {
  INFO: aiV1.FindingSeverity.FINDING_SEVERITY_INFO,
  WARNING: aiV1.FindingSeverity.FINDING_SEVERITY_WARNING,
  CRITICAL: aiV1.FindingSeverity.FINDING_SEVERITY_CRITICAL,
};

const SEVERITY_FROM_PROTO: ReadonlyMap<aiV1.FindingSeverity, Severity> = new Map([
  [aiV1.FindingSeverity.FINDING_SEVERITY_INFO, 'INFO'],
  [aiV1.FindingSeverity.FINDING_SEVERITY_WARNING, 'WARNING'],
  [aiV1.FindingSeverity.FINDING_SEVERITY_CRITICAL, 'CRITICAL'],
]);

/** El modelo puede tardar: el deadline es mayor que el de una consulta normal. */
const DEADLINE_MS = 45_000;

function findingFromProto(finding: aiV1.Finding): Finding {
  return { code: finding.code, severity: SEVERITY_FROM_PROTO.get(finding.severity) ?? 'INFO', message: finding.message, evidence: finding.evidence };
}

/** Implementa AiPort con AiService.AuditArtwork. */
export class GrpcAiClient implements AiPort {
  constructor(
    private readonly ai: aiV1.AiServiceClient,
    private readonly tokens: ServiceTokenProvider,
  ) {}

  async audit(dossier: Dossier): Promise<Assessment> {
    const { lot } = dossier;
    const response = await invoke(
      this.ai.auditArtwork.bind(this.ai),
      aiV1.AuditArtworkRequest.fromPartial({
        lotId: lot.lotId,
        title: lot.title,
        description: lot.description,
        materials: lot.materials,
        creationYear: lot.creationYear ?? undefined,
        imageHashes: lot.images.flatMap((image) => (image.perceptualHash ? [image.perceptualHash] : [])),
        artistName: lot.artistName ?? undefined,
        declaredDimensions: lot.widthCm !== null && lot.heightCm !== null ? `${String(lot.widthCm)}x${String(lot.heightCm)} cm` : 'sin dato',
        provenance: lot.provenance,
        evidence: dossier.evidence,
        ruleFindings: dossier.ruleFindings.map((finding) => ({ ...finding, severity: SEVERITY_TO_PROTO[finding.severity] })),
      }),
      { deadlineMs: DEADLINE_MS, authorization: await this.tokens.authorization() },
    );
    return {
      model: response.model,
      promptVersion: response.promptVersion,
      score: response.score,
      critical: response.critical,
      priceMin: response.priceMin,
      priceMax: response.priceMax,
      findings: response.findings.map(findingFromProto),
    };
  }
}
