import { BadRequestException, Body, Controller, Delete, Get, Headers, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { catalogV1, commonV1, galleryV1, identityV1, notificationV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { invoke } from '@artauction/service-kit';
import { CATALOG_CLIENT, GALLERY_CLIENT, IDENTITY_CLIENT, NOTIFICATION_CLIENT } from '../../../clients/grpc-clients';
import type { GatewayConfig } from '../../../config';
import { RequestLocale, type Locale } from '../locale';
import { GATEWAY_CONFIG, GATEWAY_LOGGER } from '../tokens';
import { activityJson, galleryItemJson, galleryJson, notificationJson, publicGalleryJson, publicRoomJson, purchasedSheetJson, SUPPORT_FROM_JSON } from './gallery.presenter';

export class ListPublicGalleriesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(24)
  pageSize?: number;

  @IsOptional()
  @IsIn(['recent', 'popular'])
  sort?: 'recent' | 'popular';
}

export class GalleryVisibilityDto {
  @IsIn(['PUBLIC', 'PRIVATE'])
  visibility!: 'PUBLIC' | 'PRIVATE';
}

const VISIBILITY_FROM_JSON: Readonly<Record<'PUBLIC' | 'PRIVATE', commonV1.Visibility>> = {
  PUBLIC: commonV1.Visibility.VISIBILITY_PUBLIC,
  PRIVATE: commonV1.Visibility.VISIBILITY_PRIVATE,
};

export class GenerateGalleryDto {
  @IsOptional()
  preferences?: unknown;

  @IsOptional()
  @IsBoolean()
  random?: boolean;

  @IsOptional()
  @IsBoolean()
  replaceApplied?: boolean;
}

export class PlaceArtworkDto {
  @IsOptional()
  @IsUUID()
  lotId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  posX?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  posY?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  posZ?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rotY?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(3)
  scale?: number;

  @IsOptional()
  @IsIn(['WALL', 'PEDESTAL', 'FLOOR', 'PLATFORM', 'NICHE'])
  support?: string;
}

/** Struct de proto: solo objetos JSON planos. */
function asStruct(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Galeria 3D personal (/me/gallery), servida por gallery-service. El gateway
 * completa cada obra colgada con su ficha publica de catalog (composicion con
 * degradacion, ADR 0006): si catalog no responde, la sala sale sin obras.
 */
@Controller('me/gallery')
export class PersonalGalleryController {
  constructor(
    @Inject(GALLERY_CLIENT) private readonly gallery: galleryV1.GalleryServiceClient,
    @Inject(CATALOG_CLIENT) private readonly catalog: catalogV1.CatalogServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(GATEWAY_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  @Get()
  async mine(@Headers('authorization') authorization: string | undefined, @RequestLocale() locale: Locale) {
    const response = await invoke(this.gallery.getMyGallery.bind(this.gallery), {}, this.options(authorization));
    return this.compose(response.gallery, locale);
  }

  @Post('preferences')
  async preferences(@Headers('authorization') authorization: string | undefined, @Body() body: GenerateGalleryDto, @RequestLocale() locale: Locale) {
    const response = await invoke(
      this.gallery.saveGalleryPreferences.bind(this.gallery),
      { preferences: asStruct(body.preferences), random: body.random === true },
      this.options(authorization),
    );
    return this.compose(response.gallery, locale);
  }

  @Post('generate')
  async generate(@Headers('authorization') authorization: string | undefined, @Body() body: GenerateGalleryDto, @RequestLocale() locale: Locale) {
    const response = await invoke(
      this.gallery.generateGallery.bind(this.gallery),
      { preferences: asStruct(body.preferences), random: body.random === true, replaceApplied: body.replaceApplied === true, locale },
      { ...this.options(authorization), deadlineMs: Math.max(this.config.GRPC_DEADLINE_MS, 35_000) },
    );
    return this.compose(response.gallery, locale);
  }

  @Patch('config')
  async applyConfig(@Headers('authorization') authorization: string | undefined, @Body() body: Record<string, unknown>, @RequestLocale() locale: Locale) {
    const response = await invoke(this.gallery.applyGalleryConfig.bind(this.gallery), { config: asStruct(body) }, this.options(authorization));
    return this.compose(response.gallery, locale);
  }

  @Post('restore')
  async restore(@Headers('authorization') authorization: string | undefined, @RequestLocale() locale: Locale) {
    const response = await invoke(this.gallery.restoreSuggestedConfig.bind(this.gallery), {}, this.options(authorization));
    return this.compose(response.gallery, locale);
  }

  @Patch('visibility')
  async setVisibility(@Headers('authorization') authorization: string | undefined, @Body() body: GalleryVisibilityDto, @RequestLocale() locale: Locale) {
    const response = await invoke(this.gallery.setGalleryVisibility.bind(this.gallery), { visibility: VISIBILITY_FROM_JSON[body.visibility] }, this.options(authorization));
    return this.compose(response.gallery, locale);
  }

  @Patch('items/:lotId/visibility')
  async setItemVisibility(
    @Headers('authorization') authorization: string | undefined,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() body: GalleryVisibilityDto,
  ) {
    const response = await invoke(this.gallery.setItemVisibility.bind(this.gallery), { lotId, visibility: VISIBILITY_FROM_JSON[body.visibility] }, this.options(authorization));
    if (!response.item) {
      throw new Error('gallery-service respondio sin obra');
    }
    return galleryItemJson(response.item);
  }

  @Post('artworks')
  async add(@Headers('authorization') authorization: string | undefined, @Body() body: PlaceArtworkDto, @RequestLocale() locale: Locale) {
    if (!body.lotId) {
      throw new BadRequestException('Falta la obra.');
    }
    const response = await invoke(this.gallery.addArtwork.bind(this.gallery), { lotId: body.lotId }, this.options(authorization));
    return this.compose(response.gallery, locale);
  }

  @Delete('artworks/:lotId')
  async remove(@Headers('authorization') authorization: string | undefined, @Param('lotId', ParseUUIDPipe) lotId: string, @RequestLocale() locale: Locale) {
    const response = await invoke(this.gallery.removeArtwork.bind(this.gallery), { lotId }, this.options(authorization));
    return this.compose(response.gallery, locale);
  }

  @Patch('artworks/:lotId')
  async place(
    @Headers('authorization') authorization: string | undefined,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() body: PlaceArtworkDto,
    @RequestLocale() locale: Locale,
  ) {
    const response = await invoke(
      this.gallery.placeArtwork.bind(this.gallery),
      galleryV1.PlaceArtworkRequest.fromPartial({
        lotId,
        posX: body.posX,
        posY: body.posY,
        posZ: body.posZ,
        rotY: body.rotY,
        scale: body.scale,
        support: body.support ? SUPPORT_FROM_JSON[body.support] : galleryV1.ArtworkSupport.ARTWORK_SUPPORT_UNSPECIFIED,
      }),
      this.options(authorization),
    );
    return this.compose(response.gallery, locale);
  }

  private async compose(gallery: galleryV1.PersonalGallery | undefined, locale: Locale) {
    if (!gallery) {
      throw new Error('gallery-service respondio sin galeria');
    }
    // gallery-service manda la ficha de cada obra colgada: todo lo colgado es de
    // la duena, aunque sea privado o ya vendido. Solo si falta se pide la publica.
    const lots = new Map<string, catalogV1.Lot>(
      gallery.artworks.flatMap((artwork) => (artwork.lot ? [[artwork.lotId, artwork.lot] as const] : [])),
    );
    const missing = [...new Set(gallery.artworks.map((artwork) => artwork.lotId))].filter((lotId) => !lots.has(lotId));
    if (missing.length > 0) {
      try {
        const response = await invoke(this.catalog.batchGetPublicLots.bind(this.catalog), { lotIds: missing }, this.options());
        for (const lot of response.lots) {
          lots.set(lot.id, lot);
        }
      } catch (error) {
        this.logger.warn(`sala sin fichas de catalog: ${error instanceof Error ? error.message : String(error)}`, 'gallery');
      }
    }
    return galleryJson(gallery, lots, locale);
  }

  private options(authorization?: string) {
    return { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization };
  }
}

/** Galeria social y feed, servidos por gallery-service. */
@Controller()
export class SocialController {
  constructor(
    @Inject(GALLERY_CLIENT) private readonly gallery: galleryV1.GalleryServiceClient,
    @Inject(IDENTITY_CLIENT) private readonly identity: identityV1.IdentityServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  /**
   * Galerias para explorar. Un perfil privado no se lista; como se descarta aqui,
   * una pagina puede traer menos tarjetas que su tamano.
   */
  @Get('galleries')
  async explore(@Query() query: ListPublicGalleriesQuery) {
    const response = await invoke(
      this.gallery.listPublicGalleries.bind(this.gallery),
      galleryV1.ListPublicGalleriesRequest.fromPartial({
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 12,
        sort: query.sort === 'popular' ? galleryV1.PublicGallerySort.PUBLIC_GALLERY_SORT_POPULAR : galleryV1.PublicGallerySort.PUBLIC_GALLERY_SORT_RECENT,
      }),
      this.options(),
    );
    const cards = await Promise.all(
      response.galleries.map(async (gallery) => {
        const profile = await this.publicProfile(gallery.ownerId);
        return profile ? publicGalleryJson(gallery, profile) : null;
      }),
    );
    return { items: cards.filter((card) => card !== null), total: response.total, page: query.page ?? 1, pageSize: query.pageSize ?? 12 };
  }

  /** Cabecera de una galeria. Si es privada o no expone obras, responde con cero obras. */
  @Get('galleries/:ownerId/summary')
  async summary(@Param('ownerId', ParseUUIDPipe) ownerId: string) {
    const profile = await this.publicProfile(ownerId);
    if (!profile) {
      throw new NotFoundException('Galeria no encontrada');
    }
    const response = await invoke(
      this.gallery.listPublicGalleries.bind(this.gallery),
      galleryV1.ListPublicGalleriesRequest.fromPartial({ page: 1, pageSize: 1, ownerId }),
      this.options(),
    );
    const gallery = response.galleries[0] ?? galleryV1.PublicGallerySummary.fromPartial({ ownerId });
    return publicGalleryJson(gallery, profile);
  }

  /** La sala 3D para visitantes; privada responde 404, salvo a su duena. */
  @Get('galleries/:ownerId/room')
  async room(@Headers('authorization') authorization: string | undefined, @Param('ownerId', ParseUUIDPipe) ownerId: string, @RequestLocale() locale: Locale) {
    const response = await invoke(this.gallery.getGalleryRoom.bind(this.gallery), { ownerId }, this.options(authorization));
    if (!response.gallery) {
      throw new Error('gallery-service respondio sin galeria');
    }
    return publicRoomJson(response.gallery, locale);
  }

  @Get('galleries/:ownerId')
  async list(@Headers('authorization') authorization: string | undefined, @Param('ownerId', ParseUUIDPipe) ownerId: string) {
    const response = await invoke(this.gallery.listGalleryItems.bind(this.gallery), { ownerId }, this.options(authorization));
    return response.items.map(galleryItemJson);
  }

  /** Ficha guardada de una obra comprada: el catalogo ya no publica la original. */
  @Get('galleries/:ownerId/works/:lotId')
  async sheet(
    @Headers('authorization') authorization: string | undefined,
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @RequestLocale() locale: Locale,
  ) {
    const response = await invoke(this.gallery.getPurchasedSheet.bind(this.gallery), { ownerId, lotId }, this.options(authorization));
    if (!response.sheet) {
      throw new Error('gallery-service respondio sin ficha');
    }
    return purchasedSheetJson(response.sheet, locale);
  }

  @Delete('users/:id/follow')
  async unfollow(@Headers('authorization') authorization: string | undefined, @Param('id', ParseUUIDPipe) id: string) {
    await invoke(this.gallery.unfollowUser.bind(this.gallery), { followeeId: id }, this.options(authorization));
    return { status: 'ok' as const };
  }

  @Get('me/following')
  async following(@Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.gallery.listFollowing.bind(this.gallery), {}, this.options(authorization));
    return response.followeeIds;
  }

  @Post('users/:id/follow')
  async follow(@Headers('authorization') authorization: string | undefined, @Param('id', ParseUUIDPipe) id: string) {
    await invoke(this.gallery.followUser.bind(this.gallery), { followeeId: id }, this.options(authorization));
    return { status: 'ok' as const };
  }

  @Get('feed')
  async feed(@Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.gallery.getFeed.bind(this.gallery), {}, this.options(authorization));
    return response.activities.map(activityJson);
  }

  /** Perfil publico; null si no existe, es privado o identity no responde. */
  private async publicProfile(userId: string): Promise<identityV1.PublicProfile | null> {
    const response = await invoke(this.identity.getPublicProfile.bind(this.identity), { userId }, this.options()).catch((): null => null);
    const profile = response?.profile;
    return profile?.visibility === commonV1.Visibility.VISIBILITY_PUBLIC ? profile : null;
  }

  private options(authorization?: string) {
    return { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization };
  }
}

/** Avisos del usuario, servidos por notification-service. */
@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(NOTIFICATION_CLIENT) private readonly notifications: notificationV1.NotificationServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  @Get()
  async list(@Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.notifications.listNotifications.bind(this.notifications), {}, {
      deadlineMs: this.config.GRPC_DEADLINE_MS,
      authorization,
    });
    return response.notifications.map(notificationJson);
  }
}
