import { Injectable } from '@nestjs/common';
import { AuctionsService } from '../subastas/auctions.service';
import { CatalogoService } from '../catalogo/catalogo.service';

@Injectable()
export class AdministracionService {
  constructor(
    private readonly catalogo: CatalogoService,
    private readonly auctions: AuctionsService,
  ) {}

  async resolve(lotId: string, verdict: 'APROBADO' | 'BORRADOR') {
    if (verdict === 'BORRADOR') {
      return this.catalogo.transition(lotId, verdict, { visibility: 'PRIVATE' });
    }
    const lot = await this.catalogo.transition(lotId, 'PUBLICADA', { visibility: 'PUBLIC' });
    await this.auctions.scheduleFromLot(lotId);
    return lot;
  }
}
