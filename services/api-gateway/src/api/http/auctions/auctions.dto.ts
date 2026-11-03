import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

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

export class BuyNowDto {
  // La misma regla que en una puja: repetir la clave no compra dos veces.
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey!: string;
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

export class LiveAuctionsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  limit?: number;

  /** Cuanto hacia adelante se muestran las salas programadas. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2880)
  horizonMinutes?: number;
}
