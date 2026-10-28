import { DomainError } from '@artauction/platform';

// Los precios se guardan como decimales con dos cifras. La aritmetica se hace
// en centavos enteros para no arrastrar errores de coma flotante.

export function toCents(value: string): number {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw DomainError.invalid(`Importe no valido: ${value}`);
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

export function fromCents(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? '-' : ''}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** Las artacoins se ofertan en enteros: "850" o "850.00", nunca "850.50". */
export function assertWholeCoins(amountCents: number): number {
  if (amountCents <= 0 || amountCents % 100 !== 0) {
    throw DomainError.invalid('Las artacoins se ofertan en enteros.');
  }
  return amountCents / 100;
}

/** Texto corto de una oferta para los mensajes: "850" o "850.50". */
export function publishedAmount(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : fromCents(cents);
}
