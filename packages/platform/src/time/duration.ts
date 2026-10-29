const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Convierte duraciones como "15m" o "7d" a milisegundos. */
export function durationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];
  const scale = unit === undefined ? undefined : UNIT_MS[unit];
  if (amount === undefined || scale === undefined) {
    throw new Error(`Duracion invalida: ${value}`);
  }
  return Number(amount) * scale;
}

export function durationToSeconds(value: string): number {
  return Math.floor(durationToMs(value) / 1000);
}
