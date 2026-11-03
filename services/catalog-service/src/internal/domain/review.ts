import { DomainError } from '@artauction/platform';
import type { Lot } from './lot';
import type { LotStatus } from './lot-status';

// Revision manual de un administrador: aprobar (con rango de precio si la
// auditoria no lo estimo), devolver a borrador con un motivo para el vendedor,
// o pedir otra auditoria.

export type ReviewDecision = 'APPROVE' | 'RETURN_TO_DRAFT' | 'REAUDIT';

export interface LotReview {
  decision: ReviewDecision;
  reason: string | null;
  createdAt: Date;
}

/** Decision lista para guardar: ya validada y con el estado al que lleva. */
export interface ReviewPlan {
  decision: ReviewDecision;
  to: LotStatus;
  reason: string | null;
  priceMin: number | null;
  priceMax: number | null;
}

const REASON_MIN = 10;
const REASON_MAX = 500;
/** Tope de precio que puede fijar un administrador, en artacoins. */
const PRICE_MAX = 1_000_000;

const TARGET: Record<ReviewDecision, LotStatus> = {
  APPROVE: 'PUBLICADA',
  RETURN_TO_DRAFT: 'BORRADOR',
  REAUDIT: 'PENDIENTE_AUDITORIA',
};

/** La obra no tiene precio cuando la auditoria fallo o no lo estimo (0 o vacio). */
export function hasSuggestedPrice(lot: Pick<Lot, 'suggestedPriceMin' | 'suggestedPriceMax'>): boolean {
  return Number(lot.suggestedPriceMin ?? 0) > 0 && Number(lot.suggestedPriceMax ?? 0) > 0;
}

/** Valida la decision del administrador contra la obra y la convierte en un plan. */
export function planReview(
  lot: Pick<Lot, 'suggestedPriceMin' | 'suggestedPriceMax'>,
  input: { decision: ReviewDecision; reason?: string | null; priceMin?: number | null; priceMax?: number | null },
): ReviewPlan {
  const reason = input.reason?.trim().replace(/\s+/g, ' ') || null;
  if (input.decision === 'RETURN_TO_DRAFT') {
    if (reason === null || reason.length < REASON_MIN || reason.length > REASON_MAX) {
      throw DomainError.invalid(`Explica al vendedor por que se devuelve la obra (entre ${String(REASON_MIN)} y ${String(REASON_MAX)} caracteres).`);
    }
    return { decision: input.decision, to: TARGET.RETURN_TO_DRAFT, reason, priceMin: null, priceMax: null };
  }
  if (input.decision === 'REAUDIT') {
    return { decision: input.decision, to: TARGET.REAUDIT, reason, priceMin: null, priceMax: null };
  }
  const price = priceBand(input.priceMin ?? null, input.priceMax ?? null);
  if (price === null && !hasSuggestedPrice(lot)) {
    throw DomainError.invalid('Esta obra no tiene precio sugerido: fija el rango de precio al aprobarla.');
  }
  return { decision: 'APPROVE', to: TARGET.APPROVE, reason, priceMin: price?.min ?? null, priceMax: price?.max ?? null };
}

function priceBand(min: number | null, max: number | null): { min: number; max: number } | null {
  if (min === null && max === null) {
    return null;
  }
  if (min === null || max === null) {
    throw DomainError.invalid('Indica el precio minimo y el maximo.');
  }
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > PRICE_MAX) {
    throw DomainError.invalid(`El rango de precio debe ser de artacoins enteras entre 1 y ${PRICE_MAX.toLocaleString('es-CO')}.`);
  }
  if (max < min) {
    throw DomainError.invalid('El precio maximo no puede ser menor que el minimo.');
  }
  return { min, max };
}
