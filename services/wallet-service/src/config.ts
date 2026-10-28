import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

export class WalletConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  GRPC_HOST = '0.0.0.0';

  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT = 50053;

  @IsString()
  @Matches(/[?&]schema=wallet(&|$)/, { message: 'DATABASE_URL debe apuntar al esquema wallet' })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(1)
  JWT_PUBLIC_KEY_PATH!: string;

  @IsString()
  @MinLength(1)
  IDENTITY_GRPC_URL = '127.0.0.1:50051';

  @IsString()
  SERVICE_CLIENT_ID = 'wallet-service';

  @IsString()
  @MinLength(20)
  SERVICE_CLIENT_SECRET!: string;

  /** auction-service, para verificar pujas antes de liberar reservas vencidas. */
  @IsString()
  @MinLength(1)
  AUCTION_GRPC_URL = '127.0.0.1:50054';

  /** Comision de la plataforma por venta en puntos basicos (1000 = 10 %). */
  @IsInt()
  @Min(0)
  @Max(10_000)
  PLATFORM_FEE_BPS = 1000;

  @IsInt()
  @Min(1_000)
  RESERVATION_SWEEP_MS = 30_000;

  @IsBoolean()
  RESERVATION_SWEEP_ENABLED = true;

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
