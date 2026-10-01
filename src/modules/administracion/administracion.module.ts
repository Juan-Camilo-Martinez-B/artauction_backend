import { Module } from '@nestjs/common';
import { CatalogoModule } from '../catalogo/catalogo.module';
import { AdministracionController } from './administracion.controller';
import { AdministracionService } from './administracion.service';

@Module({
  imports: [CatalogoModule],
  controllers: [AdministracionController],
  providers: [AdministracionService],
})
export class AdministracionModule {}
