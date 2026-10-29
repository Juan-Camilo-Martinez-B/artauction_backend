import { commonV1, galleryV1, type catalogV1, type notificationV1 } from '@artauction/contracts';
import { lotJson } from '../catalog/lot.presenter';

// Forma JSON de la galeria, el feed y los avisos que el frontend ya consume.

const STATUS: ReadonlyMap<galleryV1.CustomizationStatus, string> = new Map([
  [galleryV1.CustomizationStatus.CUSTOMIZATION_STATUS_SIN_PERSONALIZAR, 'SIN_PERSONALIZAR'],
  [galleryV1.CustomizationStatus.CUSTOMIZATION_STATUS_PERSONALIZADA, 'PERSONALIZADA'],
  [galleryV1.CustomizationStatus.CUSTOMIZATION_STATUS_EDITADA, 'EDITADA'],
]);

const SUPPORT: ReadonlyMap<galleryV1.ArtworkSupport, string> = new Map([
  [galleryV1.ArtworkSupport.ARTWORK_SUPPORT_WALL, 'WALL'],
  [galleryV1.ArtworkSupport.ARTWORK_SUPPORT_PEDESTAL, 'PEDESTAL'],
  [galleryV1.ArtworkSupport.ARTWORK_SUPPORT_FLOOR, 'FLOOR'],
  [galleryV1.ArtworkSupport.ARTWORK_SUPPORT_PLATFORM, 'PLATFORM'],
  [galleryV1.ArtworkSupport.ARTWORK_SUPPORT_NICHE, 'NICHE'],
]);

export const SUPPORT_FROM_JSON: Readonly<Record<string, galleryV1.ArtworkSupport>> = {
  WALL: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_WALL,
  PEDESTAL: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_PEDESTAL,
  FLOOR: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_FLOOR,
  PLATFORM: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_PLATFORM,
  NICHE: galleryV1.ArtworkSupport.ARTWORK_SUPPORT_NICHE,
};

const SOURCE: ReadonlyMap<galleryV1.ItemSource, string> = new Map([
  [galleryV1.ItemSource.ITEM_SOURCE_PROPIA, 'PROPIA'],
  [galleryV1.ItemSource.ITEM_SOURCE_GANADA, 'GANADA'],
  [galleryV1.ItemSource.ITEM_SOURCE_GRATUITA, 'GRATUITA'],
]);

function visibility(value: commonV1.Visibility): 'PUBLIC' | 'PRIVATE' {
  return value === commonV1.Visibility.VISIBILITY_PUBLIC ? 'PUBLIC' : 'PRIVATE';
}

/**
 * Sala con la ficha de cada obra. Una obra que dejo de ser publica (por
 * ejemplo, vendida) no se muestra: la posicion queda guardada pero su ficha ya
 * no es de acceso publico.
 */
export function galleryJson(gallery: galleryV1.PersonalGallery, lots: ReadonlyMap<string, catalogV1.Lot>) {
  return {
    id: gallery.id,
    ownerId: gallery.ownerId,
    name: gallery.name,
    customizationStatus: STATUS.get(gallery.customizationStatus) ?? 'SIN_PERSONALIZAR',
    preferences: gallery.preferences ?? {},
    suggestedConfig: gallery.suggestedConfig ?? null,
    appliedConfig: gallery.appliedConfig ?? null,
    artworks: gallery.artworks.flatMap((artwork) => {
      const lot = lots.get(artwork.lotId);
      return lot
        ? [
            {
              id: artwork.id,
              lotId: artwork.lotId,
              posX: artwork.posX,
              posY: artwork.posY,
              posZ: artwork.posZ,
              rotY: artwork.rotY,
              scale: artwork.scale,
              support: SUPPORT.get(artwork.support) ?? 'WALL',
              lot: lotJson(lot),
            },
          ]
        : [];
    }),
  };
}

export function galleryItemJson(item: galleryV1.GalleryItem) {
  return {
    ownerId: item.ownerId,
    lotId: item.lotId ?? null,
    source: SOURCE.get(item.source) ?? 'PROPIA',
    visibility: visibility(item.visibility),
    title: item.title,
    artistName: item.artistName ?? null,
    imageKeys: item.imageKeys,
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
  };
}

export function activityJson(activity: galleryV1.Activity) {
  return {
    actorId: activity.actorId,
    verb: activity.verb,
    objectType: activity.objectType,
    objectId: activity.objectId,
    visibility: visibility(activity.visibility),
    summary: activity.summary,
    createdAt: activity.createdAt?.toISOString() ?? null,
  };
}

/** Los map de proto no llevan null: winnerId vuelve como null si la subasta no tuvo ganador. */
export function notificationJson(notification: notificationV1.Notification) {
  const payload: Record<string, string | null> = { ...notification.payload };
  if (notification.kind === 'AUCTION_CLOSED' && !('winnerId' in payload)) {
    payload['winnerId'] = null;
  }
  return {
    id: notification.id,
    userId: notification.userId,
    kind: notification.kind,
    payload,
    createdAt: notification.createdAt?.toISOString() ?? null,
    readAt: notification.readAt?.toISOString() ?? null,
  };
}
