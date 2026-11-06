import { status } from '@grpc/grpc-js';
import type { aiV1, identityV1 } from '@artauction/contracts';
import { catalogV1 } from '@artauction/contracts';
import { isServiceError, type StructuredLogger } from '@artauction/platform';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import {
  designFromPreferences,
  GALLERY_CONFIG_JSON_SCHEMA,
  validateGalleryConfig,
  type GalleryConfig,
  type GalleryPreferences,
} from '../../internal/domain/gallery-design';
import type { PublicLot } from '../../internal/domain/gallery';
import type { Locale } from '../../internal/domain/gallery-labels';
import type { CatalogPort, GalleryDesigner, IdentityPort } from '../../internal/application/ports';

const DEADLINE_MS = 5_000;
const DESIGN_DEADLINE_MS = 30_000;

const REPRESENTATION: ReadonlyMap<catalogV1.RepresentationKind, PublicLot['representationKind']> = new Map([
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_TWO_D, 'TWO_D'],
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_THREE_D, 'THREE_D'],
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_OTHER, 'OTHER'],
]);

function toPublicLot(lot: catalogV1.Lot): PublicLot {
  const images = [...lot.images].sort((left, right) => left.position - right.position);
  return {
    lotId: lot.id,
    title: lot.title,
    artistName: lot.artistName ?? null,
    representationKind: REPRESENTATION.get(lot.representationKind) ?? 'TWO_D',
    imageKeys: images.map((image) => image.objectKey),
    previewUrl: images[0]?.url ?? null,
    hasModel: lot.model !== undefined,
  };
}

/**
 * Implementa CatalogPort con la ficha interna de catalog (ignora la
 * visibilidad): la galeria ya comprobo que la obra es de quien la cuelga.
 */
export class GrpcCatalogClient implements CatalogPort {
  constructor(
    private readonly catalog: catalogV1.CatalogServiceClient,
    private readonly tokens: ServiceTokenProvider,
  ) {}

  async snapshot(lotId: string): Promise<PublicLot | null> {
    const [lot] = await this.sheets([lotId]);
    return lot ? toPublicLot(lot) : null;
  }

  /** La ficha en el lenguaje publicado de catalog, codificada en base64 para guardarla tal cual. */
  async sheet(lotId: string): Promise<string | null> {
    const [lot] = await this.sheets([lotId]);
    return lot ? Buffer.from(catalogV1.Lot.encode(lot).finish()).toString('base64') : null;
  }

  /** Fichas completas de las obras colgadas en una sala, para que el gateway la muestre. */
  async sheets(lotIds: readonly string[]): Promise<catalogV1.Lot[]> {
    if (lotIds.length === 0) {
      return [];
    }
    const response = await invoke(this.catalog.batchGetLotSnapshots.bind(this.catalog), { lotIds: [...lotIds] }, {
      deadlineMs: DEADLINE_MS,
      authorization: await this.tokens.authorization(),
    });
    return response.lots;
  }
}

/** Implementa IdentityPort con el perfil publico: basta saber que existe y su nombre. */
export class GrpcIdentityClient implements IdentityPort {
  constructor(private readonly identity: identityV1.IdentityServiceClient) {}

  async displayName(userId: string): Promise<string | null> {
    try {
      const response = await invoke(this.identity.getPublicProfile.bind(this.identity), { userId }, { deadlineMs: DEADLINE_MS });
      return response.profile?.displayName ?? null;
    } catch (error) {
      if (isServiceError(error) && error.code === status.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }
}

/**
 * Pide el diseno a ai-service y lo valida con el esquema de la galeria. Si no
 * hay modelo, ai-service no responde o la propuesta no es valida, usa el diseno
 * local: el usuario siempre obtiene una sala valida.
 */
export class AiGalleryDesigner implements GalleryDesigner {
  constructor(
    private readonly ai: aiV1.AiServiceClient,
    private readonly tokens: ServiceTokenProvider,
    private readonly logger: StructuredLogger,
  ) {}

  async design(preferences: GalleryPreferences, locale: Locale): Promise<GalleryConfig> {
    try {
      const response = await invoke(
        this.ai.designGallery.bind(this.ai),
        { preferences: { ...preferences }, responseSchema: GALLERY_CONFIG_JSON_SCHEMA, locale },
        { deadlineMs: DESIGN_DEADLINE_MS, authorization: await this.tokens.authorization() },
      );
      return validateGalleryConfig(response.config);
    } catch (error) {
      const reason = isServiceError(error) ? error.details : error instanceof Error ? error.message : String(error);
      this.logger.warn(`diseno local en lugar de ai-service: ${reason}`, 'gallery-design');
      return designFromPreferences(preferences, 'ai-local', locale);
    }
  }
}
