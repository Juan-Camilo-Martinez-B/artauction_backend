import { commonV1, galleryV1, type catalogV1, type identityV1, type notificationV1 } from '@artauction/contracts';
import { lotJson } from '../catalog/lot.presenter';
import type { Locale } from '../locale';

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
  [galleryV1.ItemSource.ITEM_SOURCE_PROYECTO, 'PROYECTO'],
  [galleryV1.ItemSource.ITEM_SOURCE_PROPIA, 'PROPIA'],
  [galleryV1.ItemSource.ITEM_SOURCE_GANADA, 'GANADA'],
]);

function visibility(value: commonV1.Visibility): 'PUBLIC' | 'PRIVATE' {
  return value === commonV1.Visibility.VISIBILITY_PUBLIC ? 'PUBLIC' : 'PRIVATE';
}

/**
 * Sala con la ficha de cada obra. La ficha la manda gallery-service, porque
 * todo lo colgado es de la duena aunque sea privado o vendido. Una obra sin
 * ficha (catalog no respondio) no se muestra; su posicion queda guardada.
 */
export function galleryJson(gallery: galleryV1.PersonalGallery, lots: ReadonlyMap<string, catalogV1.Lot>, locale: Locale) {
  return {
    id: gallery.id,
    ownerId: gallery.ownerId,
    name: gallery.name,
    visibility: visibility(gallery.visibility),
    customizationStatus: STATUS.get(gallery.customizationStatus) ?? 'SIN_PERSONALIZAR',
    preferences: gallery.preferences ?? {},
    suggestedConfig: gallery.suggestedConfig ?? null,
    appliedConfig: gallery.appliedConfig ?? null,
    artworks: artworksJson(gallery, lots, locale),
  };
}

/** La sala para visitantes: nada de los gustos que eligio su duena ni de la propuesta de la IA. */
export function publicRoomJson(gallery: galleryV1.PersonalGallery, locale: Locale) {
  const lots = new Map(gallery.artworks.flatMap((artwork) => (artwork.lot ? [[artwork.lotId, artwork.lot] as const] : [])));
  return {
    ownerId: gallery.ownerId,
    visibility: visibility(gallery.visibility),
    appliedConfig: gallery.appliedConfig ?? null,
    artworks: artworksJson(gallery, lots, locale),
  };
}

function artworksJson(gallery: galleryV1.PersonalGallery, lots: ReadonlyMap<string, catalogV1.Lot>, locale: Locale) {
  return gallery.artworks.flatMap((artwork) => {
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
            lot: lotJson(lot, null, locale),
          },
        ]
      : [];
  });
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
    previewUrl: item.previewUrl ?? null,
  };
}

/** Tarjeta de una galeria al explorar: lo publico de su duena y su perfil. */
export function publicGalleryJson(gallery: galleryV1.PublicGallerySummary, profile: identityV1.PublicProfile) {
  return {
    ownerId: gallery.ownerId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl ?? null,
    workCount: gallery.workCount,
    followerCount: gallery.followerCount,
    latestAt: gallery.latestAt?.toISOString() ?? null,
    previews: gallery.previews.map(galleryItemJson),
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

/** Ficha guardada: la misma forma de una obra del catalogo, con los datos de la compra. */
export function purchasedSheetJson(sheet: galleryV1.PurchasedSheet, locale: Locale) {
  return {
    ownerId: sheet.ownerId,
    lot: sheet.lot ? lotJson(sheet.lot, null, locale) : null,
    pricePaid: sheet.pricePaid ?? null,
    buyNow: sheet.buyNow ?? null,
    acquiredAt: sheet.acquiredAt?.toISOString() ?? null,
  };
}
