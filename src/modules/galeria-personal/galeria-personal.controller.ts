import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../identidad/auth.service';
import { CurrentUser } from '../identidad/current-user.decorator';
import { PlaceArtworkDto, GenerateGalleryDto } from './dto';
import { GaleriaPersonalService } from './galeria-personal.service';

@ApiTags('galeria-personal')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('me/gallery')
export class GaleriaPersonalController {
  constructor(private readonly galleries: GaleriaPersonalService) {}

  @Get()
  mine(@CurrentUser() user: AuthUser) {
    return this.galleries.mine(user.userId);
  }

  @Post('preferences')
  preferences(@CurrentUser() user: AuthUser, @Body() body: GenerateGalleryDto) {
    return this.galleries.savePreferences(user.userId, body.preferences ?? {}, body.random === true);
  }

  @Post('generate')
  generate(@CurrentUser() user: AuthUser, @Body() body: GenerateGalleryDto) {
    return this.galleries.generate(user.userId, body.preferences ?? {}, body.random === true, body.replaceApplied === true);
  }

  @Patch('config')
  config(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.galleries.applyManual(user.userId, body);
  }

  @Post('restore')
  restore(@CurrentUser() user: AuthUser) {
    return this.galleries.restoreSuggested(user.userId);
  }

  @Post('artworks')
  add(@CurrentUser() user: AuthUser, @Body() body: PlaceArtworkDto) {
    if (!body.lotId) {
      throw new BadRequestException('Falta la obra.');
    }
    return this.galleries.addArtwork(user.userId, body.lotId);
  }

  @Delete('artworks/:lotId')
  remove(@CurrentUser() user: AuthUser, @Param('lotId') lotId: string) {
    return this.galleries.removeArtwork(user.userId, lotId);
  }

  @Patch('artworks/:lotId')
  place(@CurrentUser() user: AuthUser, @Param('lotId') lotId: string, @Body() body: PlaceArtworkDto) {
    return this.galleries.placeArtwork(user.userId, lotId, body);
  }
}
