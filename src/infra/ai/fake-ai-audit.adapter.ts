import { Injectable } from '@nestjs/common';
import { normalizePriceBand, type AuditResult } from '../../modules/auditoria-ia/score';
import type { AiAuditPort, AuditInput } from './ai-audit.port';

@Injectable()
export class FakeAiAuditAdapter implements AiAuditPort {
  readonly model = 'fake-audit';

  audit(input: AuditInput): Promise<AuditResult> {
    const materials = input.materials.toLowerCase();
    const acrylic = materials.includes('acríl') || materials.includes('acril');
    const critical = acrylic && (input.creationYear ?? 9999) < 1950;
    const score = critical ? 28 : 82;
    const base = critical ? 50 : 400;
    const band = normalizePriceBand(base, base * 2);
    return Promise.resolve({
      model: this.model,
      promptVersion: 'v1',
      score,
      critical,
      priceMin: band.priceMin,
      priceMax: band.priceMax,
      findings: critical
        ? [
            {
              code: 'MATERIAL_YEAR_CONFLICT',
              severity: 'CRITICAL',
              message: 'El material no existía en el año declarado.',
            },
          ]
        : [],
    });
  }
}
