// Genera el SQL con las traducciones curadas del catalogo de demostracion. Opus-MT
// falla justo con lo que abunda aqui (nombres propios y terminos de arte), asi
// que estas fichas llevan traducciones escritas a proposito en
// demo-catalog/translations.json.
//
//   npm run --silent catalog:demo:translations > traducciones.sql
//   psql "$DATABASE_URL" -f traducciones.sql
//
// Lee las fichas reales por el gateway y guarda cada traduccion con la huella del
// texto publicado. Si alguien edita luego su ficha, la huella deja de coincidir y
// el traductor automatico la retoma: no hace falta ningun caso especial.
//
// Hay que aplicarlo cuando la cola de traduccion haya terminado con estas obras:
// el traductor reemplaza lo que haya de la misma ficha al guardar. Es repetible.
// Usa las mismas variables DEMO_* que publish-demo-catalog.mjs.
import { createHash } from 'node:crypto';
import {
  SELLER_PASSWORD,
  api,
  catalogEntries,
  creditAuthors,
  digitalCredit,
  flatCredit,
  login,
  modelCredit,
  personalEntries,
  readData,
  requirePasswords,
  sellerEmail,
} from './demo-catalog/shared.mjs';

// Mismo valor que TEXT_SEPARATOR y textHash en catalog-service (domain/translation.ts).
const TEXT_SEPARATOR = '\u001f';
const CURATED_MODEL = 'curated';

function textHash({ title, description, materials, provenance }) {
  return createHash('sha256').update([title, description, materials, provenance ?? ''].join(TEXT_SEPARATOR), 'utf8').digest('hex');
}

const literal = (text) => `'${String(text).replaceAll("'", "''")}'`;

/** El credito en el otro idioma se arma con las mismas funciones que el original. */
function translatedCredit({ kind, work }, lot, lang) {
  if (kind === 'flat') return flatCredit(work, lang);
  if (kind === 'digital') return digitalCredit(lang);
  return modelCredit(work.asset, creditAuthors(lot.provenance), lang);
}

requirePasswords();
const { materials, works } = readData('translations.json');
const entries = [...catalogEntries(), ...personalEntries().map((work) => ({ kind: work.kind, work }))];

const missing = entries.flatMap(({ work }) => [
  ...(works[work.title] ? [] : [`ficha: ${work.title}`]),
  ...(materials[work.materials] ? [] : [`material: ${work.materials}`]),
]);
if (missing.length > 0) {
  console.error(`Faltan traducciones:\n${missing.join('\n')}`);
  process.exit(1);
}

const owned = new Map();
for (const key of new Set(entries.map(({ work }) => work.seller))) {
  const token = await login(sellerEmail(key), SELLER_PASSWORD);
  owned.set(key, await api('GET', '/lots/mine', { token }));
}

const rows = [];
for (const entry of entries) {
  const { work } = entry;
  const lot = owned.get(work.seller).find((item) => item.title === work.title);
  if (!lot) {
    console.error(`Sin publicar, se omite: ${work.title}`);
    continue;
  }
  const locale = work.lang === 'en' ? 'es' : 'en';
  const [title, description] = works[work.title];
  const values = [lot.id, locale, title, description, materials[work.materials], translatedCredit(entry, lot, locale), textHash(lot), CURATED_MODEL];
  rows.push(`  (${values.map(literal).join(', ')})`);
}

console.log(`\\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE curated (lot_id UUID, locale TEXT, title TEXT, description TEXT, materials TEXT, provenance TEXT, source_hash TEXT, model TEXT) ON COMMIT DROP;
INSERT INTO curated VALUES
${rows.join(',\n')};
-- Solo queda la traduccion curada de cada ficha, igual que al guardar el traductor.
DELETE FROM catalog.lot_translations t USING curated c WHERE t.lot_id = c.lot_id;
INSERT INTO catalog.lot_translations (lot_id, locale, title, description, materials, provenance, source_hash, model)
SELECT lot_id, locale, title, description, materials, provenance, source_hash, model FROM curated;
SELECT count(*) AS traducciones_curadas FROM curated;
COMMIT;`);
