import { Module } from '@nestjs/common';
import { AuditQueue } from '../infra/queue/audit-queue';
import { SubastasModule } from '../modules/subastas/subastas.module';
import { LegacyGrpcService } from './legacy-grpc.service';

// Transitorio: GaleriasService llega por el modulo global de galerias.
@Module({
  imports: [SubastasModule],
  providers: [LegacyGrpcService, AuditQueue],
})
export class LegacyGrpcModule {}
