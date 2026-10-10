import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Environment } from '../../common/config/environment';
import {
  GalleryDesignError,
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

@Injectable()
export class GeminiGalleryDesignAdapter implements GalleryDesignPort {
  readonly source = 'gemini' as const;

  constructor(@Inject(ENV) private readonly env: Environment) {}

  async design(preferences: GalleryPreferences): Promise<GalleryConfig> {
    if (!this.env.geminiConfigured) {
      throw new GalleryDesignError('GEMINI_API_KEY no está configurada');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.env.GEMINI_MODEL)}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptFor(preferences) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
    });
    if (!response.ok) {
      throw new GalleryDesignError(`Gemini respondió ${String(response.status)}`);
    }
    const payload: unknown = await response.json();
    const parsed: unknown = JSON.parse(readText(payload));
    const record = parsed as { source?: string };
    if (typeof parsed === 'object' && parsed !== null) {
      record.source = 'gemini';
    }
    return validateGalleryConfig(parsed);
  }
}

export function preferencesFromBody(body: unknown, random: boolean): GalleryPreferences {
  if (random) {
    return randomPreferences();
  }
  return parsePreferences(body);
}

function promptFor(preferences: GalleryPreferences): string {
  return [
    'Convierte estas preferencias en una configuración de galería 3D.',
    'Responde solo JSON del esquema 1, sin texto extra.',
    'schemaVersion debe ser 1 y source debe ser "gemini".',
    'spaceType: MINIMAL, CLASSIC, INDUSTRIAL, CONCRETE, WOOD, FUTURIST o EXPERIMENTAL.',
    'roomWidth 8-20, roomDepth 6-16, roomHeight 3-6, zones 1-4.',
    'Colores #rrggbb. wall material: plaster, marble, concrete, wood o metal.',
    'floor: wood, stone, concrete o marble.',
    'sculptureSupport: pedestal, vitrine, platform, niche, floor o mixed.',
    'ambientIntensity 0.15-1.2, colorTemperature 2500-6500, spotIntensity 0-2.',
    'tour, approach y artStyles deben usar los mismos identificadores de las preferencias.',
    'motion: slow, reduced, simple, contrast o default.',
    'No inventes materiales fuera de esa lista.',
    JSON.stringify(preferences),
  ].join('\n');
}

function readText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('candidates' in payload)) {
    throw new GalleryDesignError('Respuesta de Gemini sin candidatos');
  }
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new GalleryDesignError('Respuesta de Gemini vacía');
  }
  const first: unknown = candidates[0];
  if (typeof first !== 'object' || first === null || !('content' in first)) {
    throw new GalleryDesignError('Candidato de Gemini inválido');
  }
  const content = first.content;
  if (typeof content !== 'object' || content === null || !('parts' in content)) {
    throw new GalleryDesignError('Contenido de Gemini inválido');
  }
  const parts = content.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new GalleryDesignError('Gemini no devolvió texto');
  }
  const part: unknown = parts[0];
  if (typeof part !== 'object' || part === null || !('text' in part) || typeof part.text !== 'string') {
    throw new GalleryDesignError('Gemini no devolvió texto');
  }
  return part.text;
}
