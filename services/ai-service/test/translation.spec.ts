import type { LanguageDetector, Translator } from '../src/internal/application/ports';
import { TranslateLot } from '../src/internal/application/translate-lot';
import { introducesNumbers, protectSegments, splitForTranslation, targetLocales, type Locale } from '../src/internal/domain/translation';

/** Traductor falso: marca cada texto con la direccion, y anota las llamadas. */
class FakeTranslator implements Translator {
  readonly name = 'fake-mt';
  readonly calls: Array<{ from: Locale; to: Locale; texts: string[] }> = [];
  translate(texts: string[], from: Locale, to: Locale): Promise<string[]> {
    this.calls.push({ from, to, texts });
    return Promise.resolve(texts.map((text) => `[${from}>${to}] ${text}`));
  }
}

/** Detector falso: espanol si el texto tiene alguna palabra tipica, ingles si no. */
const detector: LanguageDetector = {
  detect: (text) => (/\b(de|el|la|en|con|sobre)\b|[áéíóúñ]/i.test(text) ? 'es' : text.trim() ? 'en' : null),
};

describe('trozos para el modelo', () => {
  it('junta oraciones hasta el limite y respeta los parrafos', () => {
    const text = 'Primera oracion. Segunda oracion.\n\nOtro parrafo aqui.';
    const { chunks, join } = splitForTranslation(text, 40);
    expect(chunks).toEqual(['Primera oracion. Segunda oracion.', 'Otro parrafo aqui.']);
    expect(join(chunks)).toBe(text);
  });

  it('parte por palabras una oracion mas larga que el limite', () => {
    const { chunks } = splitForTranslation('uno dos tres cuatro cinco seis', 10);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks.join(' ')).toBe('uno dos tres cuatro cinco seis');
  });

  it('protege direcciones, correos y citas con marcadores y los devuelve a su lugar', () => {
    const text = 'Copia de «The Age of Bronze», ver https://polyhaven.com/a/x o polyhaven.com y escribir a obras@museo.org.';
    const { masked, restore } = protectSegments(text);
    expect(masked).toBe('Copia de ZXQ0, ver ZXQ1 o ZXQ2 y escribir a ZXQ3.');
    expect(restore('Copy of ZXQ0, see ZXQ1 or ZXQ2 and write to ZXQ3.')).toBe(
      'Copy of «The Age of Bronze», see https://polyhaven.com/a/x or polyhaven.com and write to obras@museo.org.',
    );
  });

  it('si el modelo pierde un marcador, no se arma un texto incompleto', () => {
    const { restore } = protectSegments('Por «Benny Weimer» en polyhaven.com.');
    expect(restore('By ZXQ0 on Poly.')).toBeNull();
    // Un marcador repetido tambien es una salida rara del modelo: se descarta.
    expect(restore('By ZXQ0 on ZXQ1 and ZXQ1.')).toBeNull();
    // Cambiar el orden es valido: el otro idioma puede ordenar distinto la oracion.
    expect(restore('On ZXQ1, by ZXQ0.')).toBe('On polyhaven.com, by «Benny Weimer».');
  });

  it('cada idioma se traduce a los demas', () => {
    expect(targetLocales('es')).toEqual(['en']);
    expect(targetLocales('en')).toEqual(['es']);
  });
});

describe('traduccion de una ficha', () => {
  it('detecta el idioma en la descripcion y traduce todos los campos al otro idioma', async () => {
    const translator = new FakeTranslator();
    const result = await new TranslateLot(translator, detector).execute({
      title: 'Estatua de mármol',
      description: 'Figura de pie en mármol blanco, de tamaño natural.',
      materials: 'Mármol',
      provenance: null,
    });
    expect(result.sourceLocale).toBe('es');
    expect(result.model).toBe('fake-mt');
    expect(result.translations).toHaveLength(1);
    expect(result.translations[0]?.locale).toBe('en');
    expect(result.translations[0]?.texts.description).toBe('[es>en] Figura de pie en mármol blanco, de tamaño natural.');
    expect(result.translations[0]?.texts.provenance).toBeNull();
    // Una sola llamada al modelo por direccion.
    expect(translator.calls).toHaveLength(1);
  });

  it('copia sin traducir un campo que ya esta en el idioma destino (fichas mixtas del Met)', async () => {
    const translator = new FakeTranslator();
    const result = await new TranslateLot(translator, detector).execute({
      title: 'Marble statue of Hermes',
      description: 'Escultura romana de mármol que representa al dios Hermes.',
      materials: 'Marble',
      provenance: 'Rogers Fund, 1912',
    });
    const english = result.translations[0]?.texts;
    expect(result.sourceLocale).toBe('es');
    expect(english?.title).toBe('Marble statue of Hermes');
    expect(english?.description.startsWith('[es>en]')).toBe(true);
    expect(english?.provenance).toBe('Rogers Fund, 1912');
  });

  it('una ficha en ingles se traduce al espanol', async () => {
    const result = await new TranslateLot(new FakeTranslator(), detector).execute({
      title: 'Brass vase',
      description: 'A tall brass vase with a long neck and a bulbous belly.',
      materials: 'Brass',
      provenance: null,
    });
    expect(result.sourceLocale).toBe('en');
    expect(result.translations.map((translation) => translation.locale)).toEqual(['es']);
    expect(result.translations[0]?.texts.title).toBe('[en>es] Brass vase');
  });

  it('una cita dentro de la descripcion se conserva; si el modelo la pierde, queda el original', async () => {
    const translator = new FakeTranslator();
    const lot = { title: 'Copia de bronce', description: 'Copia en yeso de «The Age of Bronze», de Rodin, con su pátina.', materials: 'Yeso', provenance: null };
    const kept = await new TranslateLot(translator, detector).execute(lot);
    expect(kept.translations[0]?.texts.description).toBe('[es>en] Copia en yeso de «The Age of Bronze», de Rodin, con su pátina.');

    const lossy: Translator = { name: 'lossy', translate: (texts) => Promise.resolve(texts.map(() => 'Plaster copy of the bronze, by Rodin.')) };
    const original = await new TranslateLot(lossy, detector).execute(lot);
    expect(original.translations[0]?.texts.description).toBe(lot.description);
    expect(original.translations[0]?.texts.title).toBe('Plaster copy of the bronze, by Rodin.');
  });

  it('el idioma se detecta sin lo citado: una descripcion del Met sigue siendo espanol', async () => {
    // Detector que se deja llevar por el ingles citado, como tinyld con mucho texto en comillas.
    const swayed: LanguageDetector = { detect: (text) => (/landscape|graphite/i.test(text) ? 'en' : detector.detect(text)) };
    const translator = new FakeTranslator();
    const result = await new TranslateLot(translator, swayed).execute({
      title: 'Arcadian landscape',
      description: '«Arcadian landscape» entra al catálogo como pintura de George Barret. Material: «Watercolor over graphite».',
      materials: 'Watercolor over graphite',
      provenance: null,
    });
    expect(result.sourceLocale).toBe('es');
    expect(result.translations[0]?.texts).toMatchObject({ title: 'Arcadian landscape', materials: 'Watercolor over graphite' });
    expect(result.translations[0]?.texts.description).toMatch(/^\[es>en\] «Arcadian landscape» entra/);
  });

  it('una traduccion que inventa numeros se descarta y queda el original', async () => {
    const inventive: Translator = { name: 'inventive', translate: (texts) => Promise.resolve(texts.map((text) => `${text}, 120 x 36 cm`)) };
    const lot = { title: 'Retrato de 1887', description: 'Retrato al óleo pintado en 1887.', materials: 'Óleo sobre lienzo', provenance: null };
    const result = await new TranslateLot(inventive, detector).execute(lot);
    expect(result.translations[0]?.texts).toEqual(lot);
    expect(introducesNumbers('Datada en 1820–42', 'Dated 1820-1842')).toBe(true);
    expect(introducesNumbers('Retrato de 1887', 'Portrait from 1887')).toBe(false);
  });

  it('sin traductor responde que la traduccion esta desactivada', async () => {
    await expect(new TranslateLot(null, detector).execute({ title: 't', description: 'd', materials: 'm', provenance: null })).rejects.toMatchObject({
      kind: 'FAILED_PRECONDITION',
    });
  });
});
