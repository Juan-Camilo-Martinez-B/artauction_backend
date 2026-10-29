export const ART_STYLES = [
  'clasico',
  'renacimiento',
  'barroco',
  'romanticismo',
  'impresionismo',
  'postimpresionismo',
  'moderno',
  'contemporaneo',
  'minimalismo',
  'abstracto',
  'surrealismo',
  'digital',
  'combinacion',
] as const;

export const ATMOSPHERES = [
  'elegante',
  'sereno',
  'minimalista',
  'vanguardista',
  'calido',
  'dramatico',
  'futurista',
  'eclectico',
] as const;

export const COLOR_FAMILIES = ['claros', 'oscuros', 'calidos', 'frios', 'neutros', 'intensos', 'equilibrada'] as const;
export const PALETTES = ['marfil', 'piedra', 'grafito', 'terracota', 'oliva', 'azul', 'borgona', 'personalizada'] as const;
export const ARCHITECTURES = ['minimal', 'museo-clasico', 'loft', 'hormigon', 'madera', 'futurista', 'experimental'] as const;
export const LAYOUTS = ['pocas', 'equilibrada', 'abiertos', 'habitaciones', 'intimas', 'esculturas', 'combinacion'] as const;
export const SCULPTURE_ROLES = ['protagonistas', 'igual', 'complementarias', 'murales'] as const;
export const LIGHTS = ['natural', 'calida', 'neutra', 'blanca', 'dramatica', 'focos', 'indirecta', 'combinada'] as const;
export const LIGHT_MOODS = ['serenidad', 'energia', 'misterio', 'elegancia', 'calidez', 'fidelidad'] as const;
export const INTENSITIES = ['baja', 'media', 'alta'] as const;
export const MATERIALS = ['madera', 'marmol', 'hormigon', 'yeso', 'metal', 'cristal', 'artesanal', 'combinacion'] as const;
export const DISPLAYS = ['pedestales', 'vitrinas', 'plataformas', 'nichos', 'suelo', 'combinacion'] as const;
export const TOURS = ['libre', 'guiado', 'habitaciones', 'abiertos', 'tematicas', 'cronologico'] as const;
export const APPROACHES = ['ficha', 'detallada', 'camara', 'relacionadas'] as const;
export const ACCESS = ['lento', 'reducir', 'sencillos', 'contraste', 'ninguna'] as const;

export interface GalleryPreferences {
  artStyles: string[];
  favoriteStyle: string;
  atmosphere: string;
  colorFamily: string;
  paletteId: string;
  contrastWithArt: boolean;
  architecture: string;
  layout: string;
  sculptureRole: string;
  light: string;
  lightMood: string;
  intensity: string;
  materials: string[];
  sculptureDisplay: string;
  tour: string;
  approach: string;
  accessibility: string;
}

export interface GalleryConfig {
  schemaVersion: 1;
  source: 'ai-local' | 'gemini' | 'manual' | 'random';
  identity: { styleName: string; summary: string; artStyles: string[] };
  architecture: {
    spaceType: 'MINIMAL' | 'CLASSIC' | 'INDUSTRIAL' | 'CONCRETE' | 'WOOD' | 'FUTURIST' | 'EXPERIMENTAL';
    roomWidth: number;
    roomDepth: number;
    roomHeight: number;
    zones: number;
  };
  palette: { wall: string; floor: string; ceiling: string; accent: string; pedestal: string };
  materials: {
    wall: 'plaster' | 'marble' | 'concrete' | 'wood' | 'metal';
    floor: 'wood' | 'stone' | 'concrete' | 'marble';
    sculptureSupport: 'pedestal' | 'vitrine' | 'platform' | 'niche' | 'floor' | 'mixed';
  };
  lighting: { ambientIntensity: number; colorTemperature: number; spotIntensity: number; mood: string };
  navigation: { tour: string; approach: string; motion: 'slow' | 'reduced' | 'simple' | 'contrast' | 'default' };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const PALETTE_HEX: Record<(typeof PALETTES)[number], GalleryConfig['palette']> = {
  marfil: { wall: '#f4efe4', floor: '#c4a574', ceiling: '#f7f3ea', accent: '#8c5a3c', pedestal: '#d8c3a5' },
  piedra: { wall: '#f2f2f0', floor: '#b7b7b2', ceiling: '#f7f7f5', accent: '#6e6e68', pedestal: '#deded8' },
  grafito: { wall: '#2a2a2a', floor: '#1c1c1c', ceiling: '#3a3a3a', accent: '#8d8d8d', pedestal: '#4a4a4a' },
  terracota: { wall: '#e7d3c4', floor: '#8c4a32', ceiling: '#f3e6da', accent: '#6b3a2a', pedestal: '#c4a48a' },
  oliva: { wall: '#e7e2d2', floor: '#5f6b45', ceiling: '#f3f0e6', accent: '#3e4a32', pedestal: '#d5cbb4' },
  azul: { wall: '#d5dbe3', floor: '#1e3a5f', ceiling: '#eef2f6', accent: '#f4f1ea', pedestal: '#c5ced8' },
  borgona: { wall: '#2c2424', floor: '#1a1414', ceiling: '#3a3030', accent: '#8a6a3b', pedestal: '#4a3a32' },
  personalizada: { wall: '#efe8dc', floor: '#8d7b68', ceiling: '#f6f1e8', accent: '#7a2e24', pedestal: '#cbbba6' },
};

const SPACE: Record<(typeof ARCHITECTURES)[number], GalleryConfig['architecture']['spaceType']> = {
  minimal: 'MINIMAL',
  'museo-clasico': 'CLASSIC',
  loft: 'INDUSTRIAL',
  hormigon: 'CONCRETE',
  madera: 'WOOD',
  futurista: 'FUTURIST',
  experimental: 'EXPERIMENTAL',
};

export class GalleryDesignError extends Error {}

export function parsePreferences(input: unknown): GalleryPreferences {
  const raw = asRecord(input);
  const artStyles = stringList(raw['artStyles'], ART_STYLES);
  if (artStyles.length === 0) {
    throw new GalleryDesignError('Elige al menos un estilo artístico.');
  }
  const favoriteStyle = oneOf(raw['favoriteStyle'], ART_STYLES, 'estilo preferido');
  if (!artStyles.includes(favoriteStyle)) {
    throw new GalleryDesignError('El estilo preferido tiene que estar entre los seleccionados.');
  }
  return {
    artStyles,
    favoriteStyle,
    atmosphere: oneOf(raw['atmosphere'], ATMOSPHERES, 'ambiente'),
    colorFamily: oneOf(raw['colorFamily'], COLOR_FAMILIES, 'familia de color'),
    paletteId: oneOf(raw['paletteId'], PALETTES, 'paleta'),
    contrastWithArt: raw['contrastWithArt'] === true,
    architecture: oneOf(raw['architecture'], ARCHITECTURES, 'arquitectura'),
    layout: oneOf(raw['layout'], LAYOUTS, 'distribución'),
    sculptureRole: oneOf(raw['sculptureRole'], SCULPTURE_ROLES, 'papel de la escultura'),
    light: oneOf(raw['light'], LIGHTS, 'iluminación'),
    lightMood: oneOf(raw['lightMood'], LIGHT_MOODS, 'ambiente luminoso'),
    intensity: oneOf(raw['intensity'], INTENSITIES, 'intensidad'),
    materials: stringList(raw['materials'], MATERIALS),
    sculptureDisplay: oneOf(raw['sculptureDisplay'], DISPLAYS, 'soporte'),
    tour: oneOf(raw['tour'], TOURS, 'recorrido'),
    approach: oneOf(raw['approach'], APPROACHES, 'acercamiento'),
    accessibility: oneOf(raw['accessibility'], ACCESS, 'accesibilidad'),
  };
}

export function designFromPreferences(preferences: GalleryPreferences, source: GalleryConfig['source']): GalleryConfig {
  const palette = shiftPalette(PALETTE_HEX[preferences.paletteId as (typeof PALETTES)[number]], preferences);
  const width = preferences.layout === 'abiertos' || preferences.layout === 'esculturas' ? 16 : 12;
  const depth = preferences.layout === 'intimas' ? 8 : 10;
  const zones = preferences.layout === 'habitaciones' ? 3 : preferences.layout === 'combinacion' ? 2 : 1;
  const ambient = preferences.intensity === 'baja' ? 0.28 : preferences.intensity === 'alta' ? 0.92 : 0.55;
  const temperature =
    preferences.light === 'calida' ? 2700 : preferences.light === 'blanca' || preferences.light === 'natural' ? 5600 : 4000;
  const spot = preferences.light === 'dramatica' || preferences.light === 'focos' ? 1.4 : 0.7;
  const config: GalleryConfig = {
    schemaVersion: 1,
    source,
    identity: {
      styleName: labelStyle(preferences.favoriteStyle),
      summary: `Sala ${preferences.atmosphere} con acento de ${preferences.favoriteStyle}.`,
      artStyles: preferences.artStyles,
    },
    architecture: {
      spaceType: SPACE[preferences.architecture as (typeof ARCHITECTURES)[number]],
      roomWidth: width,
      roomDepth: depth,
      roomHeight: preferences.atmosphere === 'dramatico' ? 5.2 : 4,
      zones,
    },
    palette,
    materials: {
      wall: wallMaterial(preferences),
      floor: floorMaterial(preferences),
      sculptureSupport: supportOf(preferences.sculptureDisplay),
    },
    lighting: {
      ambientIntensity: preferences.light === 'dramatica' ? Math.min(ambient, 0.35) : ambient,
      colorTemperature: preferences.lightMood === 'calidez' ? 2700 : temperature,
      spotIntensity: spot,
      mood: preferences.lightMood,
    },
    navigation: {
      tour: preferences.tour,
      approach: preferences.approach,
      motion: motionOf(preferences.accessibility),
    },
  };
  return validateGalleryConfig(config);
}

export function randomPreferences(): GalleryPreferences {
  const presets: GalleryPreferences[] = [
    {
      artStyles: ['impresionismo', 'clasico'],
      favoriteStyle: 'impresionismo',
      atmosphere: 'sereno',
      colorFamily: 'claros',
      paletteId: 'marfil',
      contrastWithArt: false,
      architecture: 'museo-clasico',
      layout: 'pocas',
      sculptureRole: 'complementarias',
      light: 'natural',
      lightMood: 'serenidad',
      intensity: 'media',
      materials: ['yeso', 'madera'],
      sculptureDisplay: 'pedestales',
      tour: 'libre',
      approach: 'ficha',
      accessibility: 'ninguna',
    },
    {
      artStyles: ['minimalismo', 'contemporaneo'],
      favoriteStyle: 'minimalismo',
      atmosphere: 'minimalista',
      colorFamily: 'neutros',
      paletteId: 'piedra',
      contrastWithArt: true,
      architecture: 'minimal',
      layout: 'abiertos',
      sculptureRole: 'igual',
      light: 'neutra',
      lightMood: 'fidelidad',
      intensity: 'alta',
      materials: ['hormigon', 'yeso'],
      sculptureDisplay: 'plataformas',
      tour: 'abiertos',
      approach: 'detallada',
      accessibility: 'sencillos',
    },
    {
      artStyles: ['barroco'],
      favoriteStyle: 'barroco',
      atmosphere: 'dramatico',
      colorFamily: 'oscuros',
      paletteId: 'borgona',
      contrastWithArt: true,
      architecture: 'museo-clasico',
      layout: 'intimas',
      sculptureRole: 'protagonistas',
      light: 'dramatica',
      lightMood: 'misterio',
      intensity: 'baja',
      materials: ['marmol', 'madera'],
      sculptureDisplay: 'nichos',
      tour: 'guiado',
      approach: 'camara',
      accessibility: 'lento',
    },
  ];
  const index = Math.floor(Math.random() * presets.length);
  const chosen = presets[index] ?? presets[0];
  if (!chosen) {
    throw new GalleryDesignError('No hay una configuración aleatoria disponible.');
  }
  return chosen;
}

export function validateGalleryConfig(input: unknown): GalleryConfig {
  const raw = asRecord(input);
  if (raw['schemaVersion'] !== 1) {
    throw new GalleryDesignError('La configuración no usa el esquema 1.');
  }
  const source = oneOf(raw['source'], ['ai-local', 'gemini', 'manual', 'random'] as const, 'origen');
  const identity = asRecord(raw['identity']);
  const architecture = asRecord(raw['architecture']);
  const palette = asRecord(raw['palette']);
  const materials = asRecord(raw['materials']);
  const lighting = asRecord(raw['lighting']);
  const navigation = asRecord(raw['navigation']);
  const artStyles = stringList(identity['artStyles'], ART_STYLES);
  return {
    schemaVersion: 1,
    source,
    identity: {
      styleName: text(identity['styleName'], 'nombre de estilo', 60),
      summary: text(identity['summary'], 'resumen', 240),
      artStyles,
    },
    architecture: {
      spaceType: oneOf(
        architecture['spaceType'],
        ['MINIMAL', 'CLASSIC', 'INDUSTRIAL', 'CONCRETE', 'WOOD', 'FUTURIST', 'EXPERIMENTAL'] as const,
        'tipo de espacio',
      ),
      roomWidth: ranged(architecture['roomWidth'], 8, 20, 'ancho'),
      roomDepth: ranged(architecture['roomDepth'], 6, 16, 'fondo'),
      roomHeight: ranged(architecture['roomHeight'], 3, 6, 'altura'),
      zones: ranged(architecture['zones'], 1, 4, 'zonas'),
    },
    palette: {
      wall: hex(palette['wall'], 'pared'),
      floor: hex(palette['floor'], 'suelo'),
      ceiling: hex(palette['ceiling'], 'techo'),
      accent: hex(palette['accent'], 'acento'),
      pedestal: hex(palette['pedestal'], 'pedestal'),
    },
    materials: {
      wall: oneOf(materials['wall'], ['plaster', 'marble', 'concrete', 'wood', 'metal'] as const, 'material de pared'),
      floor: oneOf(materials['floor'], ['wood', 'stone', 'concrete', 'marble'] as const, 'material de suelo'),
      sculptureSupport: oneOf(
        materials['sculptureSupport'],
        ['pedestal', 'vitrine', 'platform', 'niche', 'floor', 'mixed'] as const,
        'soporte',
      ),
    },
    lighting: {
      ambientIntensity: ranged(lighting['ambientIntensity'], 0.15, 1.2, 'luz ambiental'),
      colorTemperature: ranged(lighting['colorTemperature'], 2500, 6500, 'temperatura'),
      spotIntensity: ranged(lighting['spotIntensity'], 0, 2, 'focos'),
      mood: text(lighting['mood'], 'clima', 40),
    },
    navigation: {
      tour: oneOf(navigation['tour'], TOURS, 'recorrido'),
      approach: oneOf(navigation['approach'], APPROACHES, 'acercamiento'),
      motion: oneOf(navigation['motion'], ['slow', 'reduced', 'simple', 'contrast', 'default'] as const, 'movimiento'),
    },
  };
}

const COLOR = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };

function numberIn(minimum: number, maximum: number) {
  return { type: 'number', minimum, maximum };
}

function enumOf(values: readonly string[]) {
  return { type: 'string', enum: [...values] };
}

/**
 * JSON Schema de GalleryConfig (esquema 1), con los mismos limites que
 * validateGalleryConfig. Se envia a ai-service para que el modelo responda con
 * esta estructura; la validacion de aqui sigue siendo la que decide.
 */
export const GALLERY_CONFIG_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    source: enumOf(['gemini']),
    identity: {
      type: 'object',
      properties: {
        styleName: { type: 'string', maxLength: 60 },
        summary: { type: 'string', maxLength: 240 },
        artStyles: { type: 'array', items: enumOf(ART_STYLES), minItems: 1 },
      },
      required: ['styleName', 'summary', 'artStyles'],
    },
    architecture: {
      type: 'object',
      properties: {
        spaceType: enumOf(['MINIMAL', 'CLASSIC', 'INDUSTRIAL', 'CONCRETE', 'WOOD', 'FUTURIST', 'EXPERIMENTAL']),
        roomWidth: numberIn(8, 20),
        roomDepth: numberIn(6, 16),
        roomHeight: numberIn(3, 6),
        zones: { type: 'integer', minimum: 1, maximum: 4 },
      },
      required: ['spaceType', 'roomWidth', 'roomDepth', 'roomHeight', 'zones'],
    },
    palette: {
      type: 'object',
      properties: { wall: COLOR, floor: COLOR, ceiling: COLOR, accent: COLOR, pedestal: COLOR },
      required: ['wall', 'floor', 'ceiling', 'accent', 'pedestal'],
    },
    materials: {
      type: 'object',
      properties: {
        wall: enumOf(['plaster', 'marble', 'concrete', 'wood', 'metal']),
        floor: enumOf(['wood', 'stone', 'concrete', 'marble']),
        sculptureSupport: enumOf(['pedestal', 'vitrine', 'platform', 'niche', 'floor', 'mixed']),
      },
      required: ['wall', 'floor', 'sculptureSupport'],
    },
    lighting: {
      type: 'object',
      properties: {
        ambientIntensity: numberIn(0.15, 1.2),
        colorTemperature: numberIn(2500, 6500),
        spotIntensity: numberIn(0, 2),
        mood: { type: 'string', maxLength: 40 },
      },
      required: ['ambientIntensity', 'colorTemperature', 'spotIntensity', 'mood'],
    },
    navigation: {
      type: 'object',
      properties: {
        tour: enumOf(TOURS),
        approach: enumOf(APPROACHES),
        motion: enumOf(['slow', 'reduced', 'simple', 'contrast', 'default']),
      },
      required: ['tour', 'approach', 'motion'],
    },
  },
  required: ['schemaVersion', 'source', 'identity', 'architecture', 'palette', 'materials', 'lighting', 'navigation'],
};

export function configsDiffer(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function shiftPalette(palette: GalleryConfig['palette'], preferences: GalleryPreferences): GalleryConfig['palette'] {
  if (preferences.colorFamily === 'oscuros' && preferences.paletteId === 'marfil') {
    return PALETTE_HEX.grafito;
  }
  if (preferences.contrastWithArt) {
    return palette;
  }
  return palette;
}

function wallMaterial(preferences: GalleryPreferences): GalleryConfig['materials']['wall'] {
  if (preferences.materials.includes('marmol')) {
    return 'marble';
  }
  if (preferences.materials.includes('hormigon') || preferences.architecture === 'hormigon') {
    return 'concrete';
  }
  if (preferences.materials.includes('madera') || preferences.architecture === 'madera') {
    return 'wood';
  }
  if (preferences.materials.includes('metal') || preferences.architecture === 'loft') {
    return 'metal';
  }
  return 'plaster';
}

function floorMaterial(preferences: GalleryPreferences): GalleryConfig['materials']['floor'] {
  if (preferences.materials.includes('marmol')) {
    return 'marble';
  }
  if (preferences.materials.includes('hormigon')) {
    return 'concrete';
  }
  if (preferences.architecture === 'museo-clasico') {
    return 'stone';
  }
  return 'wood';
}

function supportOf(display: string): GalleryConfig['materials']['sculptureSupport'] {
  if (display === 'vitrinas') {
    return 'vitrine';
  }
  if (display === 'plataformas') {
    return 'platform';
  }
  if (display === 'nichos') {
    return 'niche';
  }
  if (display === 'suelo') {
    return 'floor';
  }
  if (display === 'combinacion') {
    return 'mixed';
  }
  return 'pedestal';
}

function motionOf(access: string): GalleryConfig['navigation']['motion'] {
  if (access === 'lento') {
    return 'slow';
  }
  if (access === 'reducir') {
    return 'reduced';
  }
  if (access === 'sencillos') {
    return 'simple';
  }
  if (access === 'contraste') {
    return 'contrast';
  }
  return 'default';
}

function labelStyle(style: string): string {
  return style.charAt(0).toUpperCase() + style.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GalleryDesignError('La respuesta no tiene la forma esperada.');
  }
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new GalleryDesignError(`Valor no admitido para ${label}.`);
}

function stringList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const picked = value.filter((item): item is T => typeof item === 'string' && (allowed as readonly string[]).includes(item));
  return [...new Set(picked)];
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GalleryDesignError(`Falta ${label}.`);
  }
  return value.trim().slice(0, max);
}

function hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw new GalleryDesignError(`Color de ${label} inválido.`);
  }
  return value.toLowerCase();
}

function ranged(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new GalleryDesignError(`${label} no es un número.`);
  }
  if (value < min || value > max) {
    throw new GalleryDesignError(`${label} está fuera del rango permitido.`);
  }
  return value;
}
