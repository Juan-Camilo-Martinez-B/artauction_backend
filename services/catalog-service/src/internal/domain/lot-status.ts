import { DomainError } from '@artauction/platform';

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

/** Estados en los que una obra publica aparece en el catalogo. */
export const PUBLIC_STATUSES: readonly LotStatus[] = ['APROBADO', 'PUBLICADA', 'EN_SUBASTA'];

/** Estados terminales: la obra ya no admite cambios del vendedor. */
export const CLOSED_STATUSES: readonly LotStatus[] = ['CERRADO', 'VENDIDA'];

// Maquina de estados del lote como lista de adyacencia.
const EDGES: Readonly<Record<LotStatus, readonly LotStatus[]>> = {
  BORRADOR: ['PENDIENTE_AUDITORIA'],
  PENDIENTE_AUDITORIA: ['APROBADO', 'PUBLICADA', 'REVISION_MANUAL'],
  REVISION_MANUAL: ['APROBADO', 'PUBLICADA', 'BORRADOR'],
  APROBADO: ['PUBLICADA', 'EN_SUBASTA'],
  PUBLICADA: ['EN_SUBASTA'],
  EN_SUBASTA: ['CERRADO', 'VENDIDA', 'PUBLICADA'],
  CERRADO: [],
  VENDIDA: [],
};

export function isLotStatus(value: string): value is LotStatus {
  return (LOT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: string, to: string): boolean {
  return isLotStatus(from) && isLotStatus(to) && EDGES[from].includes(to);
}

export function assertTransition(from: string, to: LotStatus): void {
  if (!canTransition(from, to)) {
    throw DomainError.invalid(`Transicion de lote ilegal: ${from} -> ${to}`);
  }
}
