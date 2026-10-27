import { IsInt, IsString, Min, MinLength } from 'class-validator';
import { loadConfig } from '../src/config/load-config';
import { durationToMs, durationToSeconds } from '../src/time/duration';

class SampleConfig {
  @IsInt()
  @Min(1)
  GRPC_PORT = 50051;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;
}

describe('loadConfig', () => {
  it('convierte tipos y respeta los valores por defecto', () => {
    const config = loadConfig(SampleConfig, { DATABASE_URL: 'postgresql://x', OTHER: 'ignored' });
    expect(config.GRPC_PORT).toBe(50051);
    expect(config.DATABASE_URL).toBe('postgresql://x');
    expect('OTHER' in config).toBe(false);
  });

  it('lee numeros desde texto', () => {
    expect(loadConfig(SampleConfig, { DATABASE_URL: 'x', GRPC_PORT: '50060' }).GRPC_PORT).toBe(50060);
  });

  it('rechaza una variable obligatoria ausente', () => {
    expect(() => loadConfig(SampleConfig, {})).toThrow(/DATABASE_URL/);
  });
});

describe('duration', () => {
  it('convierte unidades', () => {
    expect(durationToMs('15m')).toBe(900_000);
    expect(durationToSeconds('7d')).toBe(604_800);
  });

  it('rechaza un formato desconocido', () => {
    expect(() => durationToMs('15x')).toThrow(/invalida/);
  });
});
