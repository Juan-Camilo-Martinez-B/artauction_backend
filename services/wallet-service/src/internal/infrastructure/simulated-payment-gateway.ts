import type { CardDetails, ChargeResult, PaymentGateway } from '../application/ports';
import { brandOf, cardShapeOk, cardStillValid } from '../domain/card';

/**
 * Pasarela simulada: no mueve dinero real. Aprueba cualquier tarjeta con la
 * forma de su marca que no este vencida. Nunca guarda ni registra el numero
 * completo ni el CVV: solo devuelve marca y ultimos cuatro digitos.
 */
export class SimulatedPaymentGateway implements PaymentGateway {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  charge(input: { card: CardDetails; amountCents: number; idempotencyKey: string }): Promise<ChargeResult> {
    const digits = input.card.number.replace(/\s+/g, '');
    const last4 = /^\d{4}$/.test(digits.slice(-4)) ? digits.slice(-4) : '0000';
    const approved =
      input.amountCents > 0 &&
      cardShapeOk(digits, input.card.cvv) &&
      cardStillValid(input.card.expMonth, input.card.expYear, this.clock());
    return Promise.resolve({ approved, brand: brandOf(digits), last4 });
  }
}
