import { readFileSync } from 'node:fs';
import { plainToInstance } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min, MinLength, validateSync } from 'class-validator';

export class Environment {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Min(1)
  PORT = 3001;

  // Transitorio: servidor gRPC que expone al monolito como consumidor de eventos
  // de los microservicios mientras sus servicios dueños no existen. 0 lo apaga.
  @IsInt()
  @Min(0)
  LEGACY_GRPC_PORT = 0;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  @IsString()
  @MinLength(1)
  MONGODB_URI!: string;

  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(2)
  JWT_ACCESS_TTL = '15m';

  @IsString()
  @MinLength(16)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @MinLength(2)
  JWT_REFRESH_TTL = '7d';

  // Transitorio mientras dura la migracion a microservicios: con la clave
  // publica de identity-service, el monolito acepta sus access tokens RS256.
  @IsOptional()
  @IsString()
  JWT_PUBLIC_KEY_PATH = '';

  @IsOptional()
  @IsString()
  GEMINI_API_KEY = '';

  @IsString()
  @MinLength(1)
  GEMINI_MODEL = 'gemini-2.5-flash';

  @IsString()
  @MinLength(1)
  GCS_BUCKET = 'artauction-images-dev';

  @IsInt()
  @Min(60)
  GCS_SIGNED_URL_TTL_SECONDS = 900;

  @IsString()
  @MinLength(1)
  CORS_ORIGINS = 'http://localhost:3000';

  @IsString()
  @MinLength(1)
  PGBOSS_SCHEMA = 'pgboss';

  @IsIn(['local', 'gcs'])
  STORAGE_DRIVER: 'local' | 'gcs' = 'local';

  get corsOriginList(): string[] {
    return this.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  get geminiConfigured(): boolean {
    return this.GEMINI_API_KEY.trim().length > 0;
  }

  /** Clave publica RS256 de identity-service, o null si el monolito sigue con HS256. */
  get identityPublicKey(): string | null {
    const path = this.JWT_PUBLIC_KEY_PATH.trim();
    return path.length > 0 ? readFileSync(path, 'utf8') : null;
  }
}

export const ENV = Symbol('ENV');

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const env = plainToInstance(
    Environment,
    {
      NODE_ENV: source['NODE_ENV'] ?? 'development',
      PORT: source['PORT'] !== undefined ? Number(source['PORT']) : 3001,
      LEGACY_GRPC_PORT: source['LEGACY_GRPC_PORT'] !== undefined ? Number(source['LEGACY_GRPC_PORT']) : 0,
      DATABASE_URL: source['DATABASE_URL'],
      MONGODB_URI: source['MONGODB_URI'],
      JWT_ACCESS_SECRET: source['JWT_ACCESS_SECRET'],
      JWT_ACCESS_TTL: source['JWT_ACCESS_TTL'] ?? '15m',
      JWT_REFRESH_SECRET: source['JWT_REFRESH_SECRET'],
      JWT_REFRESH_TTL: source['JWT_REFRESH_TTL'] ?? '7d',
      JWT_PUBLIC_KEY_PATH: source['JWT_PUBLIC_KEY_PATH'] ?? '',
      GEMINI_API_KEY: source['GEMINI_API_KEY'] ?? '',
      GEMINI_MODEL: source['GEMINI_MODEL'] ?? 'gemini-2.5-flash',
      GCS_BUCKET: source['GCS_BUCKET'] ?? 'artauction-images-dev',
      GCS_SIGNED_URL_TTL_SECONDS:
        source['GCS_SIGNED_URL_TTL_SECONDS'] !== undefined
          ? Number(source['GCS_SIGNED_URL_TTL_SECONDS'])
          : 900,
      CORS_ORIGINS: source['CORS_ORIGINS'] ?? 'http://localhost:3000',
      PGBOSS_SCHEMA: source['PGBOSS_SCHEMA'] ?? 'pgboss',
      STORAGE_DRIVER: source['STORAGE_DRIVER'] ?? 'local',
    },
    { enableImplicitConversion: true },
  );
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detail = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  return env;
}
