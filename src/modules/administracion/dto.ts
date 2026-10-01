import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class ResolveLotDto {
  @ApiProperty({ enum: ['APROBADO', 'BORRADOR'] })
  @IsIn(['APROBADO', 'BORRADOR'])
  verdict!: 'APROBADO' | 'BORRADOR';
}
