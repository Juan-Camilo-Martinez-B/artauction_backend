import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

// Forma de las peticiones del catalogo, igual que en el monolito. Las reglas de
// negocio las vuelve a aplicar catalog-service.

export class ListLotsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsIn(['TWO_D', 'THREE_D', 'OTHER'])
  representation?: 'TWO_D' | 'THREE_D' | 'OTHER';

  @IsOptional()
  @IsIn(['recent', 'title', 'score'])
  sort?: 'recent' | 'title' | 'score';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(60)
  pageSize?: number;
}

export class CreateLotDto {
  @IsString()
  @MinLength(3)
  title!: string;

  @IsString()
  @MinLength(10)
  description!: string;

  @IsOptional()
  @IsString()
  artistName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2100)
  creationYear?: number;

  @IsString()
  @MinLength(2)
  materials!: string;

  @IsString()
  @MinLength(2)
  categorySlug!: string;

  @IsIn(['TWO_D', 'THREE_D'])
  representationKind!: 'TWO_D' | 'THREE_D';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(2000)
  widthCm!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(2000)
  heightCm!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(2000)
  depthCm?: number;

  @IsOptional()
  @IsString()
  @MinLength(3)
  provenance?: string;
}

export class SignUploadDto {
  @IsString()
  @MaxLength(60)
  contentType!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  position!: number;
}

export class RegisterImageDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  objectKey!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  position!: number;

  @IsOptional()
  @IsString()
  perceptualHash?: string;
}

export class HashImageDto {
  @IsString()
  @MinLength(8)
  @Matches(/^[A-Za-z0-9+/=\s]+$/, { message: 'imageBase64 debe ser base64' })
  imageBase64!: string;
}

export class ResolveLotDto {
  @IsIn(['APROBADO', 'BORRADOR'])
  verdict!: 'APROBADO' | 'BORRADOR';
}
