import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

const DURATION = /^\d+[smhd]$/;

export class IdentityConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  GRPC_HOST = '0.0.0.0';

  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT = 50051;

  @IsString()
  @Matches(/[?&]schema=identity(&|$)/, { message: 'DATABASE_URL debe apuntar al esquema identity' })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(1)
  JWT_PRIVATE_KEY_PATH!: string;

  @IsString()
  @MinLength(1)
  JWT_PUBLIC_KEY_PATH!: string;

  @Matches(DURATION)
  JWT_ACCESS_TTL = '15m';

  @Matches(DURATION)
  JWT_REFRESH_TTL = '7d';

  @Matches(DURATION)
  SERVICE_TOKEN_TTL = '5m';

  @IsString()
  SERVICE_CLIENTS = '';

  /** Cada cuanto se borran las sesiones de refresh vencidas. */
  @IsInt()
  @Min(60_000)
  SESSION_SWEEP_MS = 3_600_000;

  @IsBoolean()
  SESSION_SWEEP_ENABLED = true;

  @IsBoolean()
  GRPC_TLS = false;

  @IsOptional()
  @IsString()
  GRPC_TLS_CERT?: string;

  @IsOptional()
  @IsString()
  GRPC_TLS_KEY?: string;

  @IsOptional()
  @IsString()
  GRPC_TLS_CA?: string;

  get tls(): TlsSettings {
    return {
      enabled: this.GRPC_TLS,
      certPath: this.GRPC_TLS_CERT,
      keyPath: this.GRPC_TLS_KEY,
      caPath: this.GRPC_TLS_CA,
    };
  }
}
