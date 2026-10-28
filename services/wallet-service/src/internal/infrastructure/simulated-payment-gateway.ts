import type { CardDetails, ChargeResult, PaymentGateway } from '../application/ports';

/** Tarjeta de prueba que la pasarela simulada siempre rechaza. */
export const DECLINED_CARD = '4000000000000002';

/**
 * Pasarela simulada: no mueve dinero real. Aprueba una tarjeta que pasa Luhn,
 * no esta caducada y trae un CVV valido. Nunca guarda ni registra el numero
 * completo ni el CVV: solo devuelve marca y ultimos cuatro digitos.
 */
export class SimulatedPaymentGateway implements PaymentGateway {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  charge(input: { card: CardDetails; amountCents: number; idempotencyKey: string }): Promise<ChargeResult> {
    const digits = input.card.number.replace(/\s+/g, '');
    const last4 = /^\d{4}$/.test(digits.slice(-4)) ? digits.slice(-4) : '0000';
    const approved =
      input.amountCents > 0 &&
      luhnOk(digits) &&
      digits !== DECLINED_CARD &&
      /^\d{3,4}$/.test(input.card.cvv) &&
      cardStillValid(input.card.expMonth, input.card.expYear, this.clock());
    return Promise.resolve({ approved, brand: brandOf(digits), last4 });
  }
}

export function brandOf(digits: string): string {
  if (digits.startsWith('4')) {
    return 'visa';
  }
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) {
    return 'mastercard';
  }
  return 'otra';
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
  return year * 12 + expMonth >= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
}
