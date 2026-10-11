export const DECLINED_CARD = '4000000000000002';
export const COIN_PRICE_CENTS = 100;

export interface CardDraft {
  number: string;
  expMonth: number;
  expYear: number;
  cvv: string;
}

export interface CardCheck {
  accepted: boolean;
  last4: string;
  brand: string;
}

export function inspectCard(card: CardDraft, now = new Date()): CardCheck {
  const digits = card.number.replace(/\s+/g, '');
  const last4 = digits.slice(-4);
  const brand = digits.startsWith('4') ? 'visa' : digits.startsWith('5') ? 'mastercard' : 'otra';
  const safeLast4 = /^\d{4}$/.test(last4) ? last4 : '0000';
  const accepted =
    luhnOk(digits) &&
    digits !== DECLINED_CARD &&
    /^\d{3,4}$/.test(card.cvv) &&
    cardStillValid(card.expMonth, card.expYear, now);
  return { accepted, last4: safeLast4, brand };
}

export function luhnOk(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (doubleDigit) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function cardStillValid(expMonth: number, expYear: number, now: Date): boolean {
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
    return false;
  }
  const year = expYear < 100 ? 2000 + expYear : expYear;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return false;
  }
  const expiry = year * 12 + expMonth;
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
  return expiry >= current;
}
