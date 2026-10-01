export const ANTI_SNIPE_MS = 30_000;

export type BidRejection = 'NOT_ACTIVE' | 'CLOSED' | 'OWN_LOT' | 'TOO_LOW';

export type BidDecision =
  | { ok: true; nextEndsAt: Date; extended: boolean }
  | { ok: false; code: BidRejection };

export function centsToMoney(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const sign = cents < 0 ? '-' : '';
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

export function moneyToCents(value: { toFixed(digits: number): string } | string | number): number {
  const text = typeof value === 'object' ? value.toFixed(2) : Number(value).toFixed(2);
  const [whole, fraction] = text.split('.');
  return Number(whole) * 100 + Number(fraction ?? '0');
}

export function evaluateBid(input: {
  now: Date;
  auctionStatus: string;
  lotStatus: string;
  sellerId: string;
  bidderId: string;
  currentPriceCents: number;
  minIncrementCents: number;
  hasBids: boolean;
  endsAt: Date;
  amountCents: number;
}): BidDecision {
  if (input.auctionStatus !== 'ACTIVA' || input.lotStatus !== 'EN_SUBASTA') {
    return { ok: false, code: 'NOT_ACTIVE' };
  }
  if (input.now.getTime() >= input.endsAt.getTime()) {
    return { ok: false, code: 'CLOSED' };
  }
  if (input.bidderId === input.sellerId) {
    return { ok: false, code: 'OWN_LOT' };
  }
  const minimum = input.hasBids
    ? input.currentPriceCents + input.minIncrementCents
    : input.currentPriceCents;
  if (input.amountCents < minimum || input.amountCents < input.currentPriceCents) {
    return { ok: false, code: 'TOO_LOW' };
  }
  const remaining = input.endsAt.getTime() - input.now.getTime();
  const extended = remaining <= ANTI_SNIPE_MS;
  const nextEndsAt = extended ? new Date(input.endsAt.getTime() + ANTI_SNIPE_MS) : input.endsAt;
  return { ok: true, nextEndsAt, extended };
}
