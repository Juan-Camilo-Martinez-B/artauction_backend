import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { LOCALES, type Locale } from '../locale';

// Validan la forma de la peticion igual que el monolito. Las reglas de negocio
// (normalizar el correo, roles permitidos) las vuelve a aplicar identity-service.

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(256)
  password!: string;

  @IsString()
  @MinLength(2)
  displayName!: string;

  @IsOptional()
  @IsIn(['USER', 'SELLER'])
  role?: 'USER' | 'SELLER';

  /** Idioma con que la persona veia la plataforma al registrarse. */
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(256)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(20)
  refreshToken!: string;
}

export class UpdateProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;
}

export class UpdatePreferencesDto {
  @IsIn(LOCALES)
  locale!: Locale;
}
