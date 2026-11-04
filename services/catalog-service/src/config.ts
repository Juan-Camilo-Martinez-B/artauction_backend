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

  /**
   * Traduccion automatica de las fichas publicas con ai-service (Opus-MT). En
   * CI va apagada: las fichas se muestran en su idioma original.
   */
  @IsBoolean()
  TRANSLATION_ENABLED = true;

  @IsString()
  @MinLength(1)
  AI_GRPC_URL = '127.0.0.1:50055';

  /** Cada cuanto el reconciliador busca fichas sin traducir y traduce algunas. */
  @IsInt()
  @Min(1_000)
  @Max(600_000)
  TRANSLATION_INTERVAL_MS = 5_000;

  /** Fichas que traduce por pasada, de a una: el modelo usa la CPU de ai-service. */
  @IsInt()
  @Min(1)
  @Max(20)
  TRANSLATION_BATCH = 3;

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

  // Avisos al vendedor cuando un administrador le devuelve una obra.
  @IsString()
  @MinLength(1)
  NOTIFICATION_EVENTS_GRPC_URL = '127.0.0.1:50058';

  // Almacenamiento S3 de las imagenes.
  @IsString()
  @MinLength(1)
  S3_ENDPOINT!: string;

  /**
   * Direccion de S3 desde el propio servicio, para leer lo que subio el
   * navegador (el modelo 3D). S3_ENDPOINT es el host que firma, el que ve el
   * navegador; dentro de un contenedor ese host no llega a Garage. Sin valor,
   * se usa S3_ENDPOINT, que sirve cuando el servicio corre en la misma maquina.
   */
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\//)
  S3_INTERNAL_ENDPOINT?: string;

  /** Host con el que el servicio lee el bucket (ver S3_INTERNAL_ENDPOINT). */
  get s3ReadEndpoint(): string {
    return this.S3_INTERNAL_ENDPOINT ?? this.S3_ENDPOINT;
  }

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
