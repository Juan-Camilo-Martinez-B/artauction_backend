import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../identidad/auth.service';
import { CurrentUser } from '../identidad/current-user.decorator';
import { GaleriasService } from './galerias.service';

@ApiTags('galerias')
@Controller()
export class GaleriasController {
  constructor(private readonly galerias: GaleriasService) {}

  @Get('galleries/:ownerId')
  list(@Param('ownerId') ownerId: string, @CurrentUser() user?: AuthUser) {
    return this.galerias.listForViewer(ownerId, user?.userId ?? null);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Post('users/:id/follow')
  async follow(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ status: 'ok' }> {
    await this.galerias.follow(user.userId, id);
    return { status: 'ok' };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Get('feed')
  feed(@CurrentUser() user: AuthUser) {
    return this.galerias.feed(user.userId);
  }
}
