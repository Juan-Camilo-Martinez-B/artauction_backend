import { GalleryDesignError, designFromPreferences, parsePreferences, validateGalleryConfig } from '../src/modules/galeria-personal/gallery-design';

const answers = {
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
};

describe('diseño de galería', () => {
  it('rechaza un estilo preferido que no fue seleccionado', () => {
    expect(() => parsePreferences({ ...answers, favoriteStyle: 'barroco' })).toThrow(GalleryDesignError);
  });

  it('traduce la paleta elegida a colores concretos', () => {
    const config = designFromPreferences(parsePreferences(answers), 'ai-local');
    expect(config.palette.wall).toBe('#f4efe4');
    expect(config.architecture.spaceType).toBe('CLASSIC');
    expect(config.lighting.colorTemperature).toBe(5600);
  });

  it('cambia la sala cuando cambian arquitectura e iluminación', () => {
    const calm = designFromPreferences(parsePreferences(answers), 'ai-local');
    const dark = designFromPreferences(
      parsePreferences({
        ...answers,
        artStyles: ['barroco'],
        favoriteStyle: 'barroco',
        paletteId: 'borgona',
        architecture: 'loft',
        light: 'dramatica',
        intensity: 'baja',
        materials: ['metal'],
      }),
      'ai-local',
    );
    expect(dark.palette.wall).not.toBe(calm.palette.wall);
    expect(dark.architecture.spaceType).toBe('INDUSTRIAL');
    expect(dark.lighting.ambientIntensity).toBeLessThan(calm.lighting.ambientIntensity);
  });

  it('rechaza colores y dimensiones que el renderizador no puede usar', () => {
    const config = designFromPreferences(parsePreferences(answers), 'ai-local');
    expect(() => validateGalleryConfig({ ...config, palette: { ...config.palette, wall: 'rojo' } })).toThrow(
      GalleryDesignError,
    );
    expect(() =>
      validateGalleryConfig({ ...config, architecture: { ...config.architecture, roomWidth: 100 } }),
    ).toThrow(GalleryDesignError);
  });
});
