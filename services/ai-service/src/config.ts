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

  /** Unico lugar del sistema con la clave de Groq. Vacia usa la evaluacion local. */
  @IsOptional()
  @IsString()
  GROQ_API_KEY = '';

  /**
   * Modelo de Groq. Debe admitir salida JSON en modo estricto (los gpt-oss lo
   * hacen): la auditoria y el diseno de salas dependen de ese formato.
   */
  @IsString()
  @MinLength(1)
  GROQ_MODEL = 'openai/gpt-oss-120b';

  @IsInt()
  @Min(1_000)
  @Max(60_000)
  GROQ_TIMEOUT_MS = 15_000;

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

  get groqConfigured(): boolean {
    return this.GROQ_API_KEY.trim().length > 0;
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
