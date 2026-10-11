export const LOT_STATUSES = [
  'BORRADOR',
  'PENDIENTE_AUDITORIA',
  'APROBADO',
  'PUBLICADA',
  'REVISION_MANUAL',
  'EN_SUBASTA',
  'CERRADO',
  'VENDIDA',
] as const;

export type LotStatus = (typeof LOT_STATUSES)[number];

const EDGES: Record<LotStatus, readonly LotStatus[]> = {
  BORRADOR: ['PENDIENTE_AUDITORIA'],
  PENDIENTE_AUDITORIA: ['APROBADO', 'PUBLICADA', 'REVISION_MANUAL'],
  REVISION_MANUAL: ['APROBADO', 'PUBLICADA', 'BORRADOR'],
  APROBADO: ['PUBLICADA', 'EN_SUBASTA'],
  PUBLICADA: ['EN_SUBASTA'],
  EN_SUBASTA: ['CERRADO', 'VENDIDA', 'PUBLICADA'],
  CERRADO: [],
  VENDIDA: [],
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
