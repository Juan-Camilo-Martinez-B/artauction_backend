import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsString, IsUUID, MinLength } from 'class-validator';

export class OpenAuctionDto {
  @ApiProperty()
  @IsUUID()
  lotId!: string;

  @ApiProperty({ example: '100.00' })
  @IsString()
  startPrice!: string;

  @ApiProperty({ example: '10.00' })
  @IsString()
  minIncrement!: string;

  @ApiProperty()
  @IsISO8601()
  startsAt!: string;

  @ApiProperty()
  @IsISO8601()
  endsAt!: string;
}

export class PlaceBidDto {
  @ApiProperty({ example: '120.00' })
  @IsString()
  amount!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  idempotencyKey!: string;
}
