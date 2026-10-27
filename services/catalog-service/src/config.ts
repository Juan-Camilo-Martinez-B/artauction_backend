import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

export class CatalogConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  GRPC_HOST = '0.0.0.0';

  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT = 50052;

  @IsString()
  @Matches(/[?&]schema=catalog(&|$)/, { message: 'DATABASE_URL debe apuntar al esquema catalog' })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(1)
  JWT_PUBLIC_KEY_PATH!: string;

  // Credenciales de cliente para pedir el token de servicio a identity.
  @IsString()
  @MinLength(1)
  IDENTITY_GRPC_URL = '127.0.0.1:50051';

  @IsString()
  SERVICE_CLIENT_ID = 'catalog-service';

  @IsString()
  @MinLength(20)
  SERVICE_CLIENT_SECRET!: string;

  // Consumidores de los eventos del catalogo. Mientras dura la migracion apuntan
  // al servidor gRPC legado del monolito.
  @IsString()
  @MinLength(1)
  GALLERY_EVENTS_GRPC_URL!: string;

  @IsString()
  @MinLength(1)
  AUDIT_EVENTS_GRPC_URL!: string;

  @IsString()
  @MinLength(1)
  AUCTION_EVENTS_GRPC_URL!: string;

  // Almacenamiento S3 de las imagenes.
  @IsString()
  @MinLength(1)
  S3_ENDPOINT!: string;

  @IsString()
  S3_REGION = 'garage';

  @IsString()
  @MinLength(3)
  S3_BUCKET = 'artauction-media';

  @IsString()
  @MinLength(1)
  S3_ACCESS_KEY_ID!: string;

  @IsString()
  @MinLength(1)
  S3_SECRET_ACCESS_KEY!: string;

  @IsInt()
  @Min(60)
  @Max(3600)
  S3_UPLOAD_TTL_SECONDS = 900;

  /** Base publica desde la que el navegador lee las imagenes del bucket. */
  @IsString()
  @Matches(/^https?:\/\//)
  MEDIA_PUBLIC_BASE_URL!: string;

  @IsInt()
  @Min(0)
  @Max(64)
  IMAGE_HASH_WORKERS = 0;

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
