import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
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

  // Consumidores de AuctionClosed: galeria del ganador y avisos.
  @IsString()
  @MinLength(1)
  GALLERY_EVENTS_GRPC_URL = '127.0.0.1:50057';

  @IsString()
  @MinLength(1)
  NOTIFICATION_EVENTS_GRPC_URL = '127.0.0.1:50058';

  @IsInt()
  @Min(500)
  SCHEDULER_INTERVAL_MS = 5_000;

  @IsBoolean()
  SCHEDULER_ENABLED = true;

  @IsBoolean()
  OUTBOX_RELAY_ENABLED = true;

  // Subastas rotativas del catalogo: cartelera de salas cortas sobre obras publicadas.
  @IsBoolean()
  AUTO_AUCTION_ENABLED = true;

  @IsInt()
  @Min(0)
  @Max(20)
  AUTO_AUCTION_SLOTS = 3;

  @IsInt()
  @Min(1)
  @Max(180)
  AUTO_AUCTION_MIN_MINUTES = 15;

  @IsInt()
  @Min(1)
  @Max(180)
  AUTO_AUCTION_MAX_MINUTES = 30;

  @IsInt()
  @Min(60)
  @Max(3600)
  AUTO_AUCTION_MAX_LEAD_SECONDS = 300;

  @IsNumber()
  @Min(0.01)
  @Max(1)
  AUTO_AUCTION_PRICE_FACTOR = 0.1;

  /** Compra inmediata: la salida por este factor, redondeada hacia arriba a multiplos de 50. */
  @IsNumber()
  @Min(1.5)
  @Max(10)
  BUY_NOW_FACTOR = 3;

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
