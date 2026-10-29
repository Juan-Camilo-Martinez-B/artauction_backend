import { Module } from '@nestjs/common';
import { LegacyGrpcService } from './legacy-grpc.service';

// Transitorio: GaleriasService y el notificador llegan por sus modulos globales.
@Module({
  providers: [LegacyGrpcService],
})
export class LegacyGrpcModule {}
