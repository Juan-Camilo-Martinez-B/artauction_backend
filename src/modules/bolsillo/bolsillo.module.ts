import { Module } from '@nestjs/common';
import { IdentidadModule } from '../identidad/identidad.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [IdentidadModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class BolsilloModule {}
