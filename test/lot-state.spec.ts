import { assertTransition, canTransition } from '../src/common/domain/lot-state';

describe('ciclo de vida del lote', () => {
  it('permite el camino feliz hasta el cierre', () => {
    expect(canTransition('BORRADOR', 'PENDIENTE_AUDITORIA')).toBe(true);
    expect(canTransition('PENDIENTE_AUDITORIA', 'APROBADO')).toBe(true);
    expect(canTransition('PENDIENTE_AUDITORIA', 'REVISION_MANUAL')).toBe(true);
    expect(canTransition('REVISION_MANUAL', 'APROBADO')).toBe(true);
    expect(canTransition('REVISION_MANUAL', 'BORRADOR')).toBe(true);
    expect(canTransition('APROBADO', 'EN_SUBASTA')).toBe(true);
    expect(canTransition('EN_SUBASTA', 'CERRADO')).toBe(true);
  });

  it('rechaza saltos y estados desconocidos', () => {
    expect(canTransition('BORRADOR', 'EN_SUBASTA')).toBe(false);
    expect(canTransition('CERRADO', 'APROBADO')).toBe(false);
    expect(canTransition('RARO', 'APROBADO')).toBe(false);
    expect(() => {
      assertTransition('BORRADOR', 'CERRADO');
    }).toThrow(/ilegal/);
  });
});
