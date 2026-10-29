import { Injectable, type Logger } from '@nestjs/common';
import type { aiV1 } from '@artauction/contracts';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import {
  designFromPreferences,
  parsePreferences,
  randomPreferences,
  validateGalleryConfig,
  type GalleryConfig,
  type GalleryPreferences,
} from './gallery-design';

export const GALLERY_DESIGN = Symbol('GALLERY_DESIGN');

export interface GalleryDesignPort {
  readonly source: GalleryConfig['source'];
  design(preferences: GalleryPreferences): Promise<GalleryConfig>;
}

@Injectable()
export class LocalGalleryDesignAdapter implements GalleryDesignPort {
  readonly source = 'ai-local' as const;

  design(preferences: GalleryPreferences): Promise<GalleryConfig> {
    return Promise.resolve(designFromPreferences(preferences, this.source));
  }
}

/**
 * Pide el diseno a ai-service, unico duenio de la clave de Gemini, y lo valida
 * con el esquema de la galeria. Si ai-service no tiene modelo, no responde o
 * propone algo invalido, la galeria usa el diseno local: el usuario siempre
 * obtiene una configuracion valida.
 */
export class AiServiceGalleryDesignAdapter implements GalleryDesignPort {
  readonly source = 'gemini' as const;

  constructor(
    private readonly ai: aiV1.AiServiceClient,
    private readonly tokens: ServiceTokenProvider,
    private readonly fallback: GalleryDesignPort,
    private readonly logger: Logger,
  ) {}

  async design(preferences: GalleryPreferences): Promise<GalleryConfig> {
    try {
      const response = await invoke(
        this.ai.designGallery.bind(this.ai),
        { preferences: { ...preferences } },
        { deadlineMs: 30_000, authorization: await this.tokens.authorization() },
      );
      return validateGalleryConfig(response.config);
    } catch (error) {
      this.logger.warn(`ai-service no diseno la galeria, se usa el diseno local: ${error instanceof Error ? error.message : String(error)}`);
      return this.fallback.design(preferences);
    }
  }
}

export function preferencesFromBody(body: unknown, random: boolean): GalleryPreferences {
  if (random) {
    return randomPreferences();
  }
  return parsePreferences(body);
}
