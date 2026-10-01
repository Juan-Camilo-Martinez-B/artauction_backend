export const LOT_STATUSES = [
  'BORRADOR',
  'PENDIENTE_AUDITORIA',
  'APROBADO',
  'REVISION_MANUAL',
  'EN_SUBASTA',
  'CERRADO',
] as const;

export type LotStatus = (typeof LOT_STATUSES)[number];

const EDGES: Record<LotStatus, readonly LotStatus[]> = {
  BORRADOR: ['PENDIENTE_AUDITORIA'],
  PENDIENTE_AUDITORIA: ['APROBADO', 'REVISION_MANUAL'],
  REVISION_MANUAL: ['APROBADO', 'BORRADOR'],
  APROBADO: ['EN_SUBASTA'],
  EN_SUBASTA: ['CERRADO'],
  CERRADO: [],
};

export function canTransition(from: string, to: string): boolean {
  if (!isLotStatus(from) || !isLotStatus(to)) {
    return false;
  }
  return EDGES[from].includes(to);
}

export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transición de lote ilegal: ${from} → ${to}`);
  }
}

export function isLotStatus(value: string): value is LotStatus {
  return (LOT_STATUSES as readonly string[]).includes(value);
}
