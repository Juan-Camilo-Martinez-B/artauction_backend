import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

export class GatewayConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3001;

  @IsString()
  @MinLength(1)
  CORS_ORIGINS = 'http://localhost:3000';

  /** Monolito que aun atiende las rutas no migradas (Strangler Fig). Vacio lo desactiva. */
  @IsString()
  LEGACY_URL = '';

  @IsString()
  @MinLength(1)
  IDENTITY_GRPC_URL = '127.0.0.1:50051';

  @IsString()
  @MinLength(1)
  CATALOG_GRPC_URL = '127.0.0.1:50052';

  @IsString()
  @MinLength(1)
  WALLET_GRPC_URL = '127.0.0.1:50053';

  @IsString()
  @MinLength(1)
  AUCTION_GRPC_URL = '127.0.0.1:50054';

  // Mientras audit no exista como servicio, apunta al servidor gRPC legado del monolito.

  @IsString()
  @MinLength(1)
  AUDIT_GRPC_URL = '127.0.0.1:50090';

  /** Clave publica RS256 de identity-service para autenticar la sala en vivo. Vacia la desactiva. */
  @IsString()
  JWT_PUBLIC_KEY_PATH = '';

  @IsInt()
  @Min(100)
  GRPC_DEADLINE_MS = 5_000;

  @IsBoolean()
  GRPC_TLS = false;

  @IsOptional()
  @IsString()
  GRPC_TLS_CA?: string;

  @IsOptional()
  @IsString()
  GRPC_TLS_CERT?: string;

  @IsOptional()
  @IsString()
  GRPC_TLS_KEY?: string;

  get corsOrigins(): string[] {
    return this.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  get tls(): TlsSettings {
    return {
      enabled: this.GRPC_TLS,
      caPath: this.GRPC_TLS_CA,
      certPath: this.GRPC_TLS_CERT,
      keyPath: this.GRPC_TLS_KEY,
    };
  }
}
