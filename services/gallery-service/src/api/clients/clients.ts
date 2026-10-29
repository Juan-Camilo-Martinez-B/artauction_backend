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
import type { CatalogPort, GalleryDesigner, IdentityPort } from '../../internal/application/ports';

const DEADLINE_MS = 5_000;
const DESIGN_DEADLINE_MS = 30_000;

const REPRESENTATION: ReadonlyMap<catalogV1.RepresentationKind, PublicLot['representationKind']> = new Map([
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_TWO_D, 'TWO_D'],
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_THREE_D, 'THREE_D'],
  [catalogV1.RepresentationKind.REPRESENTATION_KIND_OTHER, 'OTHER'],
]);

function toPublicLot(lot: catalogV1.Lot): PublicLot {
  return {
    lotId: lot.id,
    title: lot.title,
    artistName: lot.artistName ?? null,
    representationKind: REPRESENTATION.get(lot.representationKind) ?? 'TWO_D',
    imageKeys: [...lot.images].sort((left, right) => left.position - right.position).map((image) => image.objectKey),
  };
}

/** Implementa CatalogPort: obras publicas para colgar y ficha interna para la galeria del ganador. */
export class GrpcCatalogClient implements CatalogPort {
  constructor(
    private readonly catalog: catalogV1.CatalogServiceClient,
    private readonly tokens: ServiceTokenProvider,
  ) {}

  async publicLot(lotId: string): Promise<PublicLot | null> {
    const response = await invoke(this.catalog.batchGetPublicLots.bind(this.catalog), { lotIds: [lotId] }, { deadlineMs: DEADLINE_MS });
    const lot = response.lots[0];
    return lot ? toPublicLot(lot) : null;
  }

  async snapshot(lotId: string): Promise<PublicLot | null> {
    const response = await invoke(this.catalog.batchGetLotSnapshots.bind(this.catalog), { lotIds: [lotId] }, {
      deadlineMs: DEADLINE_MS,
      authorization: await this.tokens.authorization(),
    });
    const lot = response.lots[0];
    return lot ? toPublicLot(lot) : null;
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

  async design(preferences: GalleryPreferences): Promise<GalleryConfig> {
    try {
      const response = await invoke(
        this.ai.designGallery.bind(this.ai),
        { preferences: { ...preferences }, responseSchema: GALLERY_CONFIG_JSON_SCHEMA },
        { deadlineMs: DESIGN_DEADLINE_MS, authorization: await this.tokens.authorization() },
      );
      return validateGalleryConfig(response.config);
    } catch (error) {
      const reason = isServiceError(error) ? error.details : error instanceof Error ? error.message : String(error);
      this.logger.warn(`diseno local en lugar de ai-service: ${reason}`, 'gallery-design');
      return designFromPreferences(preferences, 'ai-local');
    }
  }
}
