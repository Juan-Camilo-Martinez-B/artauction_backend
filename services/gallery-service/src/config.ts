import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

export class GalleryConfigEnv {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  GRPC_HOST = '0.0.0.0';

  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT = 50057;

  @IsString()
  @Matches(/[?&]schema=gallery(&|$)/, { message: 'DATABASE_URL debe apuntar al esquema gallery' })
  DATABASE_URL!: string;

  /** Galeria social (obras y actividad) en la base Mongo propia del servicio. */
  @IsString()
  @MinLength(1)
  JWT_PUBLIC_KEY_PATH!: string;

  @IsString()
  @MinLength(1)
  IDENTITY_GRPC_URL = '127.0.0.1:50051';

  @IsString()
  SERVICE_CLIENT_ID = 'gallery-service';

  @IsString()
  @MinLength(20)
  SERVICE_CLIENT_SECRET!: string;

  @IsString()
  @MinLength(1)
  CATALOG_GRPC_URL = '127.0.0.1:50052';

  @IsString()
  @MinLength(1)
  AI_GRPC_URL = '127.0.0.1:50055';

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
