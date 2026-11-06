// Lo que comparten los scripts del catalogo de demostracion: acceso al gateway,
// vendedores, datos y creditos. Importarlo no tiene efectos.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const DEV_PASSWORD = 'DevPassword!234';
const RATE_LIMIT_WAIT_MS = 15_000;

export const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3001';
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(API);
export const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? 'admin@artauction.local';
export const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? (IS_LOCAL ? DEV_PASSWORD : null);
export const SELLER_PASSWORD = process.env.DEMO_SELLER_PASSWORD ?? (IS_LOCAL ? DEV_PASSWORD : null);
const EMAIL_DOMAIN = process.env.DEMO_EMAIL_DOMAIN ?? 'artauction.local';

export const SELLERS = {
  aurora: 'Aurora Galería de Arte',
  bellamy: 'Bellamy Fine Art',
  norte: 'Norte Estudio y Colección',
  lumen: 'Lumen Fotografía Histórica',
  vertice: 'Vértice Arte Digital',
};

export const sellerEmail = (key) => `${key}@${EMAIL_DOMAIN}`;

/** Contra un gateway que no sea local no hay contrasenas por omision. */
export function requirePasswords() {
  if (!ADMIN_PASSWORD || !SELLER_PASSWORD) {
    console.error('Fuera de un gateway local hay que definir DEMO_ADMIN_PASSWORD y DEMO_SELLER_PASSWORD.');
    process.exit(1);
  }
}

/** Peticion al gateway; ante 429 espera y repite, porque la carga es larga. */
export async function api(method, route, { token, body } = {}) {
  for (;;) {
    const response = await fetch(`${API}${route}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 429) {
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`${method} ${route} respondio ${String(response.status)}: ${data?.message ?? text}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
}

export async function login(email, password) {
  return (await api('POST', '/auth/login', { body: { email, password } })).accessToken;
}

export const readData = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

/** Todas las obras con su tipo; falla si un titulo se repite en un vendedor. */
export function catalogEntries() {
  const entries = [
    ...readData('flat.json').map((work) => ({ kind: 'flat', work })),
    ...readData('models.json').map((work) => ({ kind: 'model', work })),
    ...readData('digital.json').map((work) => ({ kind: 'digital', work })),
  ];
  const titles = new Set(entries.map(({ work }) => `${work.seller}/${work.title}`));
  if (titles.size !== entries.length) {
    throw new Error('hay titulos repetidos en un mismo vendedor: romperian la idempotencia');
  }
  return entries;
}

/** Obras propias de las cuentas, que no se venden. Mismas reglas que el catalogo. */
export function personalEntries() {
  const works = readData('personal.json');
  const titles = new Set(works.map((work) => `${work.seller}/${work.title}`));
  if (titles.size !== works.length) {
    throw new Error('hay titulos repetidos en un mismo vendedor: romperian la idempotencia');
  }
  return works;
}

/** Titulo del museo sin la serie ni los nombres alternativos, que lo alargan mucho. */
function shortSourceTitle(title) {
  return title.replace(/,? (from the series|also known as)\b.*$/s, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function flatCredit(work, lang) {
  const source = [`"${shortSourceTitle(work.sourceTitle)}"`, work.artist, work.sourceDate].filter(Boolean).join(', ');
  const link = `artic.edu/artworks/${String(work.aic)}`;
  return lang === 'en'
    ? `Public domain reproduction (CC0) of ${source}, Art Institute of Chicago (${link}).`
    : `Reproducción de dominio público (CC0) de ${source}, Art Institute of Chicago (${link}).`;
}

export function digitalCredit(lang) {
  return lang === 'en'
    ? 'Generative piece created with code for this demo; there is no physical original.'
    : 'Pieza generativa creada con código para esta demostración; no existe un original físico.';
}

export function modelCredit(asset, authors, lang) {
  const by = authors.length === 0 ? '' : lang === 'en' ? `, by ${authors.join(' and ')}` : `, por ${authors.join(' y ')}`;
  return `${lang === 'en' ? 'CC0 3D model from' : 'Modelo 3D CC0 de'} Poly Haven (polyhaven.com/a/${asset})${by}.`;
}

/** Autores que quedaron escritos en el credito de un modelo ya publicado. */
export function creditAuthors(provenance) {
  const match = /\), (?:by|por) (.+)\.$/.exec(provenance ?? '');
  return match ? match[1].split(/ and | y /) : [];
}
