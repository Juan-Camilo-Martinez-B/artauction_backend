import { isRecord, isUuid } from '../src/validation/guards';

describe('comprobaciones de forma', () => {
  it('isRecord acepta solo objetos planos', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ score: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('texto')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it('isUuid acepta la forma canonica sin distinguir mayusculas', () => {
    expect(isUuid('b0000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('B0000000-0000-4000-8000-00000000000A')).toBe(true);
    expect(isUuid('b0000000-0000-4000-8000-00000000001')).toBe(false);
    expect(isUuid('b0000000000040008000000000000001')).toBe(false);
    expect(isUuid(' b0000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
