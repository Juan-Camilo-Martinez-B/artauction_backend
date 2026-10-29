import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import type { TlsSettings } from '@artauction/platform';

export class AiConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  GRPC_HOST = '0.0.0.0';

  @IsInt()
  @Min(0)
  @Max(65535)
  GRPC_PORT = 50055;

  /** Clave publica de identity-service para verificar los tokens de servicio. */
  @IsString()
  @MinLength(1)
  JWT_PUBLIC_KEY_PATH!: string;

  /** Unico lugar del sistema con la clave de Gemini. Vacia usa la evaluacion local. */
  @IsOptional()
  @IsString()
  GEMINI_API_KEY = '';

  @IsString()
  @MinLength(1)
  GEMINI_MODEL = 'gemini-2.5-flash';

  @IsInt()
  @Min(1_000)
  @Max(60_000)
  GEMINI_TIMEOUT_MS = 15_000;

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

  get geminiConfigured(): boolean {
    return this.GEMINI_API_KEY.trim().length > 0;
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
