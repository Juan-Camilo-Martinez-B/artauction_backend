import { Module } from '@nestjs/common';
import { AuditQueue } from '../../infra/queue/audit-queue';
import { LocalStorageAdapter, STORAGE } from '../../infra/storage/storage.port';
import { ImageHashPool } from '../../infra/workers/image-hash.pool';
import { CatalogoController } from './catalogo.controller';
import { CatalogoService } from './catalogo.service';

@Module({
  controllers: [CatalogoController],
  providers: [
    CatalogoService,
    AuditQueue,
    ImageHashPool,
    { provide: STORAGE, useClass: LocalStorageAdapter },
  ],
  exports: [CatalogoService],
})
export class CatalogoModule {}
