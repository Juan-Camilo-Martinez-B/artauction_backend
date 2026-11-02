/**
 * Reglas de forma de las tarjetas que circulan en Colombia. El cobro es
 * simulado: no se verifica el numero contra un emisor (ni siquiera con Luhn),
 * solo que tenga la longitud de su marca, un CVV del largo correcto y que no
 * este vencida. El frontend aplica las mismas reglas en src/lib/payments/card.ts.
 */
export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'diners' | 'otra';

interface BrandRule {
  digits: number;
  cvvDigits: number;
}

const RULES: Record<CardBrand, BrandRule> = {
  visa: { digits: 16, cvvDigits: 3 },
  mastercard: { digits: 16, cvvDigits: 3 },
  amex: { digits: 15, cvvDigits: 4 },
  diners: { digits: 14, cvvDigits: 3 },
  // Marcas locales o privadas (tarjetas de almacen): formato de 16 digitos.
  otra: { digits: 16, cvvDigits: 3 },
};

export function brandOf(digits: string): CardBrand {
  if (/^3[47]/.test(digits)) {
    return 'amex';
  }
  if (/^3(?:0[0-5]|[68])/.test(digits)) {
    return 'diners';
  }
  if (digits.startsWith('4')) {
    return 'visa';
  }
  if (/^5[1-5]/.test(digits) || /^2(?:2[2-9]|[3-6]\d|7[01]|720)/.test(digits)) {
    return 'mastercard';
  }
  return 'otra';
}

/** Numero y CVV con la forma de su marca. Acepta espacios en el numero. */
export function cardShapeOk(number: string, cvv: string): boolean {
  const digits = number.replace(/\s+/g, '');
  if (!/^\d+$/.test(digits)) {
    return false;
  }
  const rule = RULES[brandOf(digits)];
  return digits.length === rule.digits && new RegExp(`^\\d{${String(rule.cvvDigits)}}$`).test(cvv);
}

/** La tarjeta vale hasta el ultimo dia de su mes de vencimiento. */
export function cardStillValid(expMonth: number, expYear: number, now: Date): boolean {
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
    return false;
  }
  const year = expYear < 100 ? 2000 + expYear : expYear;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return false;
  }
  return year * 12 + expMonth >= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
}
