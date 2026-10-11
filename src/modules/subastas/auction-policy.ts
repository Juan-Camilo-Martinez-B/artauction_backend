export const AUCTION_CONTRACT = 'artauction-auction-contract-1';

export const WITHDRAW_LEAD_MS = 4 * 60 * 1000;
export const MIN_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 180;
export const MIN_LEAD_MS = 15 * 60 * 1000;
export const MAX_LEAD_MS = 48 * 60 * 60 * 1000;
export const MIN_OPENING_COINS = 50;
export const MIN_INCREMENT_COINS = 10;

export function durationMinutes(score: number): number {
  const clamped = Math.min(100, Math.max(40, Math.round(score)));
  const span = MAX_DURATION_MINUTES - MIN_DURATION_MINUTES;
  return MIN_DURATION_MINUTES + Math.round(((clamped - 40) / 60) * span);
}

export function openingCoins(priceMin: number, priceMax: number): number {
  const mid = Math.round((Math.max(0, priceMin) + Math.max(0, priceMax)) / 2);
  return Math.max(MIN_OPENING_COINS, mid);
}

export function incrementCoins(opening: number): number {
  return Math.max(MIN_INCREMENT_COINS, Math.round(opening * 0.05));
}

export function saleDescription(title: string, rationale: string): string {
  const clean = rationale.trim().replace(/\s+/g, ' ');
  const text = clean.length > 0 ? `${title}. ${clean}` : title;
  return text.slice(0, 500);
}

export function scheduleWindow(
  now: Date,
  duration: number,
  randomUnit = Math.random,
): { startsAt: Date; endsAt: Date } {
  const unit = Math.min(0.999999, Math.max(0, randomUnit()));
  const lead = MIN_LEAD_MS + Math.floor(unit * (MAX_LEAD_MS - MIN_LEAD_MS));
  const startsAt = new Date(now.getTime() + lead);
  if (startsAt.getTime() <= now.getTime()) {
    throw new Error('La fecha de subasta no puede estar en el pasado.');
  }
  const minutes = Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(duration)));
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  return { startsAt, endsAt };
}

export function canWithdraw(now: Date, endsAt: Date): boolean {
  return endsAt.getTime() - now.getTime() >= WITHDRAW_LEAD_MS;
}

export function holdIncrease(previous: number, next: number): number {
  if (!Number.isInteger(previous) || !Number.isInteger(next) || previous < 0 || next <= previous) {
    throw new Error('La retención solo crece en artacoins enteros.');
  }
  return next - previous;
}

export function publishedAmount(cents: number): string {
  if (cents % 100 === 0) {
    return String(cents / 100);
  }
  const abs = Math.abs(Math.trunc(cents));
  return `${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

export function amountTakenMessage(cents: number): string {
  return `La oferta de ${publishedAmount(cents)} ya fue publicada por otro usuario.`;
}
