import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

export class AuctionConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  GRPC_HOST = '0.0.0.0';

  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT = 50054;

  @IsString()
  @Matches(/[?&]schema=auction(&|$)/, { message: 'DATABASE_URL debe apuntar al esquema auction' })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(1)
  JWT_PUBLIC_KEY_PATH!: string;

  @IsString()
  @MinLength(1)
  IDENTITY_GRPC_URL = '127.0.0.1:50051';

  @IsString()
  SERVICE_CLIENT_ID = 'auction-service';

  @IsString()
  @MinLength(20)
  SERVICE_CLIENT_SECRET!: string;

  @IsString()
  @MinLength(1)
  CATALOG_GRPC_URL = '127.0.0.1:50052';

  @IsString()
  @MinLength(1)
  WALLET_GRPC_URL = '127.0.0.1:50053';

  // Consumidores de los eventos de subasta. Gallery y notification siguen en el
  // servidor gRPC legado del monolito hasta F8.
  @IsString()
  @MinLength(1)
  GALLERY_EVENTS_GRPC_URL = '127.0.0.1:50090';

  @IsString()
  @MinLength(1)
  NOTIFICATION_EVENTS_GRPC_URL = '127.0.0.1:50090';

  @IsInt()
  @Min(500)
  SCHEDULER_INTERVAL_MS = 5_000;

  @IsBoolean()
  SCHEDULER_ENABLED = true;

  @IsBoolean()
  OUTBOX_RELAY_ENABLED = true;

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
