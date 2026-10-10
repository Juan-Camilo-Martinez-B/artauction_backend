import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class GenerateGalleryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  preferences?: unknown;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  random?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  replaceApplied?: boolean;
}

export class PlaceArtworkDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  lotId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  posX?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  posY?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  posZ?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rotY?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(3)
  scale?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsIn(['WALL', 'PEDESTAL', 'FLOOR', 'PLATFORM', 'NICHE'])
  support?: string;
}
