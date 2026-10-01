import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../identidad/auth.service';
import { CurrentUser } from '../identidad/current-user.decorator';
import { Roles, RolesGuard } from '../identidad/roles.guard';
import { CatalogoService } from './catalogo.service';
import { CreateLotDto, HashImageDto, RegisterImageDto, SignUploadDto } from './dto';

@ApiTags('catalogo')
@Controller('lots')
export class CatalogoController {
  constructor(private readonly catalogo: CatalogoService) {}

  @Get()
  listPublic() {
    return this.catalogo.listPublic();
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user?: AuthUser) {
    return this.catalogo.getForViewer(id, user?.userId ?? null);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('SELLER', 'ADMIN')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateLotDto) {
    return this.catalogo.create(user.userId, body);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('SELLER', 'ADMIN')
  @Post(':id/hash')
  async hash(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: HashImageDto) {
    await this.catalogo.getForViewer(id, user.userId);
    const hash = await this.catalogo.hashImage(Buffer.from(body.imageBase64, 'base64'));
    return { perceptualHash: hash };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('SELLER', 'ADMIN')
  @Post(':id/uploads')
  sign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: SignUploadDto) {
    return this.catalogo.signUpload(id, user.userId, body.contentType, body.position);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('SELLER', 'ADMIN')
  @Post(':id/images')
  image(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: RegisterImageDto) {
    return this.catalogo.registerImage(id, user.userId, body);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('SELLER', 'ADMIN')
  @Post(':id/submit')
  async submit(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ status: 'PENDIENTE_AUDITORIA' }> {
    await this.catalogo.submitForAudit(id, user.userId);
    return { status: 'PENDIENTE_AUDITORIA' };
  }
}
