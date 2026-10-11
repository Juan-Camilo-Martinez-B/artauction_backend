import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateLotDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  description!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  artistName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2100)
  creationYear?: number;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  materials!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  categorySlug!: string;

  @ApiProperty({ enum: ['TWO_D', 'THREE_D'] })
  @IsIn(['TWO_D', 'THREE_D'])
  representationKind!: 'TWO_D' | 'THREE_D';

  @ApiProperty({ description: 'Ancho en centímetros' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(2000)
  widthCm!: number;

  @ApiProperty({ description: 'Alto en centímetros' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(2000)
  heightCm!: number;

  @ApiProperty({ required: false, description: 'Profundidad en centímetros. Obligatoria en objetos tridimensionales.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(2000)
  depthCm?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(3)
  provenance?: string;
}

export class RegisterImageDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  objectKey!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  perceptualHash?: string;
}

export class HashImageDto {
  @ApiProperty({ description: 'Imagen en base64' })
  @IsString()
  @MinLength(8)
  imageBase64!: string;
}

export class SignUploadDto {
  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  contentType!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position!: number;
}

export class ListLotsQuery {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
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
