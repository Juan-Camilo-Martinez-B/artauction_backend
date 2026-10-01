import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles, RolesGuard } from '../identidad/roles.guard';
import { AdministracionService } from './administracion.service';
import { ResolveLotDto } from './dto';

@ApiTags('administracion')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('admin/lots')
export class AdministracionController {
  constructor(private readonly administracion: AdministracionService) {}

  @Post(':id/resolve')
  resolve(@Param('id') id: string, @Body() body: ResolveLotDto) {
    return this.administracion.resolve(id, body.verdict);
  }
}
