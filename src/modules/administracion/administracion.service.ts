import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CatalogoService } from '../catalogo/catalogo.service';

@Injectable()
export class AdministracionService {
  constructor(private readonly catalogo: CatalogoService) {}

  resolve(lotId: string, verdict: 'APROBADO' | 'BORRADOR') {
    const patch: Prisma.LotUpdateInput =
      verdict === 'APROBADO' ? { visibility: 'PUBLIC' } : { visibility: 'PRIVATE' };
    return this.catalogo.transition(lotId, verdict, patch);
  }
}
