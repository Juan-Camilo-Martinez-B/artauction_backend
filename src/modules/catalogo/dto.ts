import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

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
