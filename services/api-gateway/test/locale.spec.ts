import { catalogV1 } from '@artauction/contracts';
import { lotJson } from '../src/api/http/catalog/lot.presenter';
import { parseAcceptLanguage } from '../src/api/http/locale';

describe('idioma pedido', () => {
  it('toma el idioma ofrecido de mayor peso y cae en espanol', () => {
    expect(parseAcceptLanguage(undefined)).toBe('es');
    expect(parseAcceptLanguage('')).toBe('es');
    expect(parseAcceptLanguage('en-US,en;q=0.9')).toBe('en');
    expect(parseAcceptLanguage('fr-FR,en;q=0.5,es;q=0.8')).toBe('es');
    expect(parseAcceptLanguage('de,fr')).toBe('es');
    expect(parseAcceptLanguage('EN')).toBe('en');
    expect(parseAcceptLanguage('en;q=0,es;q=0.1')).toBe('es');
    expect(parseAcceptLanguage('en;q=abc')).toBe('es');
  });
});

describe('ficha traducida', () => {
  const lot = catalogV1.Lot.fromPartial({
    id: 'lot-1',
    title: 'Estatua gotica',
    description: 'Figura envuelta en un manto.',
    materials: 'Piedra',
    sourceLocale: 'es',
    translations: [{ locale: 'en', title: 'Gothic statue', description: 'Figure wrapped in a cloak.', materials: 'Stone', model: 'opus-mt' }],
  });

  it('muestra la traduccion y deja el original aparte', () => {
    const json = lotJson(lot, null, 'en');
    expect(json).toMatchObject({ title: 'Gothic statue', materials: 'Stone', provenance: null, sourceLocale: 'es', translated: true });
    expect(json.original).toEqual({ title: 'Estatua gotica', description: 'Figura envuelta en un manto.', materials: 'Piedra', provenance: null });
  });

  it('sin traduccion, en el idioma original o sin idioma muestra el texto del autor', () => {
    for (const json of [lotJson(lot, null, 'es'), lotJson(lot), lotJson({ ...lot, translations: [] }, null, 'en')]) {
      expect(json).toMatchObject({ title: 'Estatua gotica', translated: false, original: null });
    }
  });
});
