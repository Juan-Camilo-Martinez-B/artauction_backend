import { commonV1, galleryHandlersV1, galleryV1 } from '@artauction/contracts';
import { DomainError, type StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { Activity, GalleryItem, PersonalGallery, Support } from '../../internal/domain/gallery';
import type { GalleryEventHandlers, PersonalGalleryUseCases, SocialUseCases } from '../../internal/application/use-cases';

const STATUS_TO_PROTO: Readonly<Record<PersonalGallery['customizationStatus'], galleryV1.CustomizationStatus>> = {
  SIN_PERSONALIZAR: galleryV1.CustomizationStatus.CUSTOMIZATION_STATUS_SIN_PERSONALIZAR,
  PERSONALIZADA: galleryV1.CustomizationStatus.CUSTOMIZATION_STATUS_PERSONALIZADA,
  EDITADA: galleryV1.CustomizationStatus.CUSTOMIZATION_STATUS_EDITADA,
};

const SUPPORT_TO_PROTO: Readonly<Record<Support, galleryV1.ArtworkSupport>> = {
  WALL: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_WALL,
  PEDESTAL: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_PEDESTAL,
  FLOOR: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_FLOOR,
  PLATFORM: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_PLATFORM,
  NICHE: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_NICHE,
};

const SUPPORT_FROM_PROTO: ReadonlyMap<galleryV1.ArtworkSupport, Support> = new Map(
  Object.entries(SUPPORT_TO_PROTO).map(([name, value]) => [value, name as Support]),
);

const SOURCE_TO_PROTO: Readonly<Record<GalleryItem['source'], galleryV1.ItemSource>> = {
  PROPIA: galleryV1.ItemSource.ITEM_SOURCE_PROPIA,
  GANADA: galleryV1.ItemSource.ITEM_SOURCE_GANADA,
  GRATUITA: galleryV1.ItemSource.ITEM_SOURCE_GRATUITA,
};

function visibility(value: 'PUBLIC' | 'PRIVATE'): commonV1.Visibility {
  return value === 'PUBLIC' ? commonV1.Visibility.VISIBILITY_PUBLIC : commonV1.Visibility.VISIBILITY_PRIVATE;
}

/** La sala sin fichas de obra: el gateway completa cada `lot` con catalog. */
function galleryToProto(gallery: PersonalGallery): galleryV1.PersonalGallery {
  return galleryV1.PersonalGallery.fromPartial({
    id: gallery.id,
    ownerId: gallery.ownerId,
    name: gallery.name,
    customizationStatus: STATUS_TO_PROTO[gallery.customizationStatus],
    preferences: gallery.preferences,
    suggestedConfig: gallery.suggestedConfig ?? undefined,
    appliedConfig: gallery.appliedConfig ?? undefined,
    artworks: gallery.artworks.map((artwork) => ({
      id: artwork.id,
      lotId: artwork.lotId,
      posX: artwork.posX,
      posY: artwork.posY,
      posZ: artwork.posZ,
      rotY: artwork.rotY,
      scale: artwork.scale,
      support: SUPPORT_TO_PROTO[artwork.support],
    })),
  });
}

function itemToProto(item: GalleryItem): galleryV1.GalleryItem {
  return galleryV1.GalleryItem.fromPartial({
    ownerId: item.ownerId,
    lotId: item.lotId ?? undefined,
    source: SOURCE_TO_PROTO[item.source],
    visibility: visibility(item.visibility),
    title: item.title,
    artistName: item.artistName ?? undefined,
    imageKeys: item.imageKeys,
    acquiredAt: item.acquiredAt,
  });
}

function activityToProto(activity: Activity): galleryV1.Activity {
  return galleryV1.Activity.fromPartial({ ...activity, visibility: visibility(activity.visibility) });
}

/** Frontera gRPC de la galeria. Cada operacion personal actua sobre quien llama. */
export function galleryGrpcService(
  useCases: { personal: PersonalGalleryUseCases; social: SocialUseCases },
  callers: CallerResolver,
  logger: StructuredLogger,
): galleryV1.GalleryServiceServer {
  const { personal, social } = useCases;
  const owner = (context: Parameters<CallerResolver['user']>[0]) => callers.user(context).userId;
  return {
    getMyGallery: unary(logger, 'GetMyGallery', async (_request, context) =>
      galleryV1.GetMyGalleryResponse.fromPartial({ gallery: galleryToProto(await personal.mine(owner(context))) }),
    ),
    saveGalleryPreferences: unary(logger, 'SaveGalleryPreferences', async (request, context) =>
      galleryV1.SaveGalleryPreferencesResponse.fromPartial({
        gallery: galleryToProto(await personal.savePreferences(owner(context), request.preferences, request.random)),
      }),
    ),
    generateGallery: unary(logger, 'GenerateGallery', async (request, context) =>
      galleryV1.GenerateGalleryResponse.fromPartial({
        gallery: galleryToProto(await personal.generate(owner(context), request.preferences, request.random, request.replaceApplied)),
      }),
    ),
    applyGalleryConfig: unary(logger, 'ApplyGalleryConfig', async (request, context) =>
      galleryV1.ApplyGalleryConfigResponse.fromPartial({ gallery: galleryToProto(await personal.applyManual(owner(context), request.config)) }),
    ),
    restoreSuggestedConfig: unary(logger, 'RestoreSuggestedConfig', async (_request, context) =>
      galleryV1.RestoreSuggestedConfigResponse.fromPartial({ gallery: galleryToProto(await personal.restoreSuggested(owner(context))) }),
    ),
    addArtwork: unary(logger, 'AddArtwork', async (request, context) =>
      galleryV1.AddArtworkResponse.fromPartial({ gallery: galleryToProto(await personal.addArtwork(owner(context), request.lotId)) }),
    ),
    removeArtwork: unary(logger, 'RemoveArtwork', async (request, context) =>
      galleryV1.RemoveArtworkResponse.fromPartial({ gallery: galleryToProto(await personal.removeArtwork(owner(context), request.lotId)) }),
    ),
    placeArtwork: unary(logger, 'PlaceArtwork', async (request, context) => {
      const support = request.support === galleryV1.ArtworkSupport.ARTWORK_SUPPORT_UNSPECIFIED ? undefined : SUPPORT_FROM_PROTO.get(request.support);
      if (request.support !== galleryV1.ArtworkSupport.ARTWORK_SUPPORT_UNSPECIFIED && support === undefined) {
        throw DomainError.invalid('Soporte no admitido.');
      }
      const gallery = await personal.placeArtwork(owner(context), request.lotId, {
        posX: request.posX,
        posY: request.posY,
        posZ: request.posZ,
        rotY: request.rotY,
        scale: request.scale,
        support,
      });
      return galleryV1.PlaceArtworkResponse.fromPartial({ gallery: galleryToProto(gallery) });
    }),
    listGalleryItems: unary(logger, 'ListGalleryItems', async (request, context) => {
      const viewer = callers.optionalUser(context)?.userId ?? null;
      return galleryV1.ListGalleryItemsResponse.fromPartial({ items: (await social.items(request.ownerId, viewer)).map(itemToProto) });
    }),
    followUser: unary(logger, 'FollowUser', async (request, context) => {
      await social.follow(owner(context), request.followeeId);
      return galleryV1.FollowUserResponse.fromPartial({});
    }),
    getFeed: unary(logger, 'GetFeed', async (_request, context) =>
      galleryV1.GetFeedResponse.fromPartial({ activities: (await social.feed(owner(context))).map(activityToProto) }),
    ),
  };
}

/** Eventos que consume la galeria: obras nuevas (catalog) y subastas ganadas (auction). */
export function galleryEventsGrpcService(
  handlers: GalleryEventHandlers,
  callers: CallerResolver,
  logger: StructuredLogger,
): galleryHandlersV1.GalleryEventHandlerServiceServer {
  return {
    handleLotCreated: unary(logger, 'HandleLotCreated', async (request, context) => {
      callers.service(context, ['catalog-service']);
      const event = request.event;
      if (event) {
        await handlers.lotCreated({
          eventId: event.metadata?.eventId ?? '',
          lotId: event.lotId,
          sellerId: event.sellerId,
          title: event.title,
          artistName: event.artistName ?? null,
        });
      }
      return galleryHandlersV1.HandleLotCreatedResponse.fromPartial({});
    }),
    handleAuctionClosed: unary(logger, 'HandleAuctionClosed', async (request, context) => {
      callers.service(context, ['auction-service']);
      const event = request.event;
      if (event) {
        await handlers.auctionClosed({ eventId: event.metadata?.eventId ?? '', lotId: event.lotId, winnerId: event.winnerId || null });
      }
      return galleryHandlersV1.HandleAuctionClosedResponse.fromPartial({});
    }),
  };
}
