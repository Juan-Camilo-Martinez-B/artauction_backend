import { Module } from '@nestjs/common';
import { LocalStorageAdapter, STORAGE } from '../../infra/storage/storage.port';
import { ImageHashPool } from '../../infra/workers/image-hash.pool';
import { IdentidadModule } from '../identidad/identidad.module';
import { CatalogoController } from './catalogo.controller';
import { CatalogoService } from './catalogo.service';

@Module({
  imports: [IdentidadModule],
  controllers: [CatalogoController],
  providers: [
    CatalogoService,
    ImageHashPool,
    { provide: STORAGE, useClass: LocalStorageAdapter },
  ],
  exports: [CatalogoService],
})
export class CatalogoModule {}
