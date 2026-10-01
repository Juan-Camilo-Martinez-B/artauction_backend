export function durationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];
  if (!amount || !unit) {
    throw new Error(`Duración inválida: ${value}`);
  }
  const scale = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Number(amount) * scale;
}

export function durationToSeconds(value: string): number {
  return Math.floor(durationToMs(value) / 1000);
}
