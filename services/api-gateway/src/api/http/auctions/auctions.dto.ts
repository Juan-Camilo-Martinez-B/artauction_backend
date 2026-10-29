import { IsISO8601, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

// Importe con hasta dos decimales, como lo envia el frontend ("850" o "850.00").
// La regla de artacoins enteras la aplica auction-service.
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;

export class OpenAuctionDto {
  @IsUUID()
  lotId!: string;

  @IsString()
  @Matches(AMOUNT)
  startPrice!: string;

  @IsString()
  @Matches(AMOUNT)
  minIncrement!: string;

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;
}

export class PlaceBidDto {
  @IsString()
  @Matches(AMOUNT)
  amount!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey!: string;
}
