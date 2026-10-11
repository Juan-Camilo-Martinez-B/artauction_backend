import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class TopUpDto {
  @ApiProperty({ example: 250, minimum: 50, maximum: 10000 })
  @IsInt()
  @Min(50)
  @Max(10_000)
  coins!: number;

  @ApiProperty({ example: '4242424242424242' })
  @IsString()
  @MinLength(12)
  @MaxLength(23)
  cardNumber!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  cardName!: string;

  @ApiProperty({ example: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  expMonth!: number;

  @ApiProperty({ example: 2030 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  expYear!: number;

  @ApiProperty({ example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/)
  cvv!: string;
}
