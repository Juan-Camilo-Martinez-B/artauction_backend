import { clampScore, decideVerdict, normalizePriceBand } from '../src/modules/auditoria-ia/score';

describe('veredicto de auditoría', () => {
  it('manda a revisión manual un score bajo o un hallazgo crítico', () => {
    expect(decideVerdict(39, false)).toBe('REVISION_MANUAL');
    expect(decideVerdict(90, true)).toBe('REVISION_MANUAL');
    expect(decideVerdict(40, false)).toBe('APROBADO');
  });

  it('acota el score y ordena la banda de precio', () => {
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(140.4)).toBe(100);
    expect(normalizePriceBand(80, 20)).toEqual({ priceMin: 20, priceMax: 80 });
  });
});
