import { Module } from '@nestjs/common';
import { AuditQueue } from '../infra/queue/audit-queue';
import { LegacyGrpcService } from './legacy-grpc.service';

// Transitorio: GaleriasService y el notificador llegan por sus modulos globales.
@Module({
  providers: [LegacyGrpcService, AuditQueue],
})
export class LegacyGrpcModule {}
