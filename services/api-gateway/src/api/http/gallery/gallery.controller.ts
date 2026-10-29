import { BadRequestException, Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { catalogV1, galleryV1, notificationV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { invoke } from '@artauction/service-kit';
import { CATALOG_CLIENT, GALLERY_CLIENT, NOTIFICATION_CLIENT } from '../../../clients/grpc-clients';
import type { GatewayConfig } from '../../../config';
import { GATEWAY_CONFIG, GATEWAY_LOGGER } from '../tokens';
import { activityJson, galleryItemJson, galleryJson, notificationJson, SUPPORT_FROM_JSON } from './gallery.presenter';

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
  async mine(@Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.gallery.getMyGallery.bind(this.gallery), {}, this.options(authorization));
    return this.compose(response.gallery);
  }

  @Post('preferences')
  async preferences(@Headers('authorization') authorization: string | undefined, @Body() body: GenerateGalleryDto) {
    const response = await invoke(
      this.gallery.saveGalleryPreferences.bind(this.gallery),
      { preferences: asStruct(body.preferences), random: body.random === true },
      this.options(authorization),
    );
    return this.compose(response.gallery);
  }

  @Post('generate')
  async generate(@Headers('authorization') authorization: string | undefined, @Body() body: GenerateGalleryDto) {
    const response = await invoke(
      this.gallery.generateGallery.bind(this.gallery),
      { preferences: asStruct(body.preferences), random: body.random === true, replaceApplied: body.replaceApplied === true },
      { ...this.options(authorization), deadlineMs: Math.max(this.config.GRPC_DEADLINE_MS, 35_000) },
    );
    return this.compose(response.gallery);
  }

  @Patch('config')
  async applyConfig(@Headers('authorization') authorization: string | undefined, @Body() body: Record<string, unknown>) {
    const response = await invoke(this.gallery.applyGalleryConfig.bind(this.gallery), { config: asStruct(body) }, this.options(authorization));
    return this.compose(response.gallery);
  }

  @Post('restore')
  async restore(@Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.gallery.restoreSuggestedConfig.bind(this.gallery), {}, this.options(authorization));
    return this.compose(response.gallery);
  }

  @Post('artworks')
  async add(@Headers('authorization') authorization: string | undefined, @Body() body: PlaceArtworkDto) {
    if (!body.lotId) {
      throw new BadRequestException('Falta la obra.');
    }
    const response = await invoke(this.gallery.addArtwork.bind(this.gallery), { lotId: body.lotId }, this.options(authorization));
    return this.compose(response.gallery);
  }

  @Delete('artworks/:lotId')
  async remove(@Headers('authorization') authorization: string | undefined, @Param('lotId', ParseUUIDPipe) lotId: string) {
    const response = await invoke(this.gallery.removeArtwork.bind(this.gallery), { lotId }, this.options(authorization));
    return this.compose(response.gallery);
  }

  @Patch('artworks/:lotId')
  async place(
    @Headers('authorization') authorization: string | undefined,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() body: PlaceArtworkDto,
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
    return this.compose(response.gallery);
  }

  private async compose(gallery: galleryV1.PersonalGallery | undefined) {
    if (!gallery) {
      throw new Error('gallery-service respondio sin galeria');
    }
    const lotIds = [...new Set(gallery.artworks.map((artwork) => artwork.lotId))];
    let lots = new Map<string, catalogV1.Lot>();
    if (lotIds.length > 0) {
      try {
        const response = await invoke(this.catalog.batchGetPublicLots.bind(this.catalog), { lotIds }, this.options());
        lots = new Map(response.lots.map((lot) => [lot.id, lot]));
      } catch (error) {
        this.logger.warn(`sala sin fichas de catalog: ${error instanceof Error ? error.message : String(error)}`, 'gallery');
      }
    }
    return galleryJson(gallery, lots);
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
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  @Get('galleries/:ownerId')
  async list(@Headers('authorization') authorization: string | undefined, @Param('ownerId', ParseUUIDPipe) ownerId: string) {
    const response = await invoke(this.gallery.listGalleryItems.bind(this.gallery), { ownerId }, this.options(authorization));
    return response.items.map(galleryItemJson);
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
