import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

export class AuditConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  GRPC_HOST = '0.0.0.0';

  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT = 50056;

  @IsString()
  @Matches(/[?&]schema=audit(&|$)/, { message: 'DATABASE_URL debe apuntar al esquema audit' })
  DATABASE_URL!: string;

  /** Mongo de audit-service; los informes van a su propia base. */
  @IsString()
  @MinLength(1)
  MONGODB_URI!: string;

  @IsString()
  @MinLength(1)
  MONGODB_DATABASE = 'artauction_audit';

  @IsString()
  @MinLength(1)
  JWT_PUBLIC_KEY_PATH!: string;

  @IsString()
  @MinLength(1)
  IDENTITY_GRPC_URL = '127.0.0.1:50051';

  @IsString()
  SERVICE_CLIENT_ID = 'audit-service';

  @IsString()
  @MinLength(20)
  SERVICE_CLIENT_SECRET!: string;

  @IsString()
  @MinLength(1)
  CATALOG_GRPC_URL = '127.0.0.1:50052';

  @IsString()
  @MinLength(1)
  AI_GRPC_URL = '127.0.0.1:50055';

  @IsString()
  @MinLength(1)
  AUCTION_EVENTS_GRPC_URL = '127.0.0.1:50054';

  /** Hasta F8 las notificaciones las atiende el servidor gRPC legado del monolito. */
  @IsString()
  @MinLength(1)
  NOTIFICATION_EVENTS_GRPC_URL = '127.0.0.1:50090';

  /** Base publica de las imagenes en Garage y su direccion interna. */
  @IsString()
  @MinLength(1)
  MEDIA_PUBLIC_BASE_URL = 'http://artauction-media.web.garage.localhost:3902';

  @IsString()
  @MinLength(1)
  MEDIA_INTERNAL_BASE_URL = 'http://127.0.0.1:3902';

  /** Hosts externos de los que se aceptan imagenes https, separados por coma. */
  @IsString()
  AUDIT_IMAGE_HOSTS = 'images.metmuseum.org';

  @IsInt()
  @Min(1_000)
  IMAGE_FETCH_TIMEOUT_MS = 8_000;

  @IsInt()
  @Min(100_000)
  @Max(30_000_000)
  IMAGE_MAX_BYTES = 12_000_000;

  @IsInt()
  @Min(500)
  WORKER_INTERVAL_MS = 3_000;

  @IsBoolean()
  WORKER_ENABLED = true;

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

  get imageHosts(): string[] {
    return this.AUDIT_IMAGE_HOSTS.split(',')
      .map((host) => host.trim())
      .filter((host) => host.length > 0);
  }

  get tls(): TlsSettings {
    return {
      enabled: this.GRPC_TLS,
      certPath: this.GRPC_TLS_CERT,
      keyPath: this.GRPC_TLS_KEY,
      caPath: this.GRPC_TLS_CA,
    };
  }
}
