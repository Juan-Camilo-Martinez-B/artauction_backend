import { Module } from '@nestjs/common';
import { CatalogoModule } from '../catalogo/catalogo.module';
import { SubastasModule } from '../subastas/subastas.module';
import { AdministracionController } from './administracion.controller';
import { AdministracionService } from './administracion.service';

@Module({
  imports: [CatalogoModule, SubastasModule],
  controllers: [AdministracionController],
  providers: [AdministracionService],
})
export class AdministracionModule {}
