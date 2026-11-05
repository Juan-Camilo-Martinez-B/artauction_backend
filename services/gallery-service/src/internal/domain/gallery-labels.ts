import type { ART_STYLES, ATMOSPHERES, LIGHT_MOODS } from './gallery-design';

/** Idiomas en que se escriben los textos de una sala (nombre de estilo, resumen, clima). */
export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'es';

/** Idioma pedido; uno desconocido o vacio usa el de omision: la sala se genera igual. */
export function localeOf(raw: string | undefined): Locale {
  return raw !== undefined && isLocale(raw) ? raw : DEFAULT_LOCALE;
}

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

type Labels<T extends readonly string[]> = Readonly<Record<Locale, Readonly<Record<T[number], string>>>>;

// Los tipos obligan a que cada identificador tenga su texto en cada idioma.
const STYLE_LABELS: Labels<typeof ART_STYLES> = {
  es: {
    clasico: 'Clásico',
    renacimiento: 'Renacimiento',
    barroco: 'Barroco',
    romanticismo: 'Romanticismo',
    impresionismo: 'Impresionismo',
    postimpresionismo: 'Postimpresionismo',
    moderno: 'Moderno',
    contemporaneo: 'Contemporáneo',
    minimalismo: 'Minimalismo',
    abstracto: 'Abstracto',
    surrealismo: 'Surrealismo',
    digital: 'Digital',
    combinacion: 'Combinación de estilos',
  },
  en: {
    clasico: 'Classical',
    renacimiento: 'Renaissance',
    barroco: 'Baroque',
    romanticismo: 'Romanticism',
    impresionismo: 'Impressionism',
    postimpresionismo: 'Post-Impressionism',
    moderno: 'Modern',
    contemporaneo: 'Contemporary',
    minimalismo: 'Minimalism',
    abstracto: 'Abstract',
    surrealismo: 'Surrealism',
    digital: 'Digital',
    combinacion: 'Mixed styles',
  },
};

// Adjetivos de la sala: en espanol concuerdan con "sala" (femenino).
const ATMOSPHERE_LABELS: Labels<typeof ATMOSPHERES> = {
  es: {
    elegante: 'elegante',
    sereno: 'serena',
    minimalista: 'minimalista',
    vanguardista: 'vanguardista',
    calido: 'cálida',
    dramatico: 'dramática',
    futurista: 'futurista',
    eclectico: 'ecléctica',
  },
  en: {
    elegante: 'Elegant',
    sereno: 'Serene',
    minimalista: 'Minimalist',
    vanguardista: 'Avant-garde',
    calido: 'Warm',
    dramatico: 'Dramatic',
    futurista: 'Futuristic',
    eclectico: 'Eclectic',
  },
};

const MOOD_LABELS: Labels<typeof LIGHT_MOODS> = {
  es: {
    serenidad: 'Serenidad',
    energia: 'Energía',
    misterio: 'Misterio',
    elegancia: 'Elegancia',
    calidez: 'Calidez',
    fidelidad: 'Fidelidad de color',
  },
  en: {
    serenidad: 'Serenity',
    energia: 'Energy',
    misterio: 'Mystery',
    elegancia: 'Elegance',
    calidez: 'Warmth',
    fidelidad: 'Color fidelity',
  },
};

function label<T extends string>(labels: Readonly<Record<T, string>>, id: string): string {
  return (labels as Readonly<Record<string, string>>)[id] ?? id;
}

/** Textos del diseno local en el idioma de quien genera la sala. */
export function designTexts(
  preferences: { favoriteStyle: string; atmosphere: string; lightMood: string },
  locale: Locale,
): { styleName: string; summary: string; mood: string } {
  const style = label(STYLE_LABELS[locale], preferences.favoriteStyle);
  const atmosphere = label(ATMOSPHERE_LABELS[locale], preferences.atmosphere);
  const summary =
    locale === 'en' ? `${atmosphere} room with an accent on ${style}.` : `Sala ${atmosphere} con acento en ${style.toLowerCase()}.`;
  return { styleName: style, summary, mood: label(MOOD_LABELS[locale], preferences.lightMood) };
}
