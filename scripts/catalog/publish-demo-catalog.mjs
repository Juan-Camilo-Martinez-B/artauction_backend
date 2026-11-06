// Carga el catalogo de demostracion: 100 obras curadas de cinco vendedores, con
// el mismo recorrido que usa el frontend (alta, imagen, modelo, auditoria y
// aprobacion del administrador con el precio de cada obra).
//
//   npm run catalog:demo
//
// Origen de las obras (datos y creditos en scripts/catalog/demo-catalog):
//   flat.json     58 reproducciones de dominio publico del Art Institute of Chicago
//   models.json   32 modelos 3D CC0 de Poly Haven
//   digital.json  10 piezas generativas creadas por generate-art.mjs
//
// Es idempotente: las cuentas y las obras que ya existen se reutilizan, y cada
// obra se retoma en el paso en que quedo. Repetir el comando no duplica nada.
//
// Conviene cargarlo con la auditoria sin modelo (GROQ_API_KEY vacia) y con
// AUDIT_LOCAL_AUTO_APPROVE=false en audit-service: asi no se gasta cuota y toda
// obra pasa por el administrador, que le fija su precio. Una obra que aun asi
// se apruebe sola queda con el precio de la auditoria y se avisa al final.
//
// Variables:
//   DEMO_API_URL           gateway, por omision http://127.0.0.1:3001
//   DEMO_ADMIN_EMAIL       administrador, por omision admin@artauction.local
//   DEMO_ADMIN_PASSWORD    contrasena del administrador
//   DEMO_SELLER_PASSWORD   contrasena de las cuentas de los vendedores
//   DEMO_EMAIL_DOMAIN      dominio de esas cuentas, por omision artauction.local
//   DEMO_ONLY              opcional: lista de titulos para cargar solo esas obras
// Las contrasenas tienen valor por omision solo contra un gateway local; contra
// cualquier otro son obligatorias, para no crear cuentas con claves conocidas.
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchAsset } from './poly-haven.mjs';
import { DIGITAL_KIND, FLAT_KIND, attachImage, uploadTo } from './demo-catalog/lot-files.mjs';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  SELLERS,
  SELLER_PASSWORD,
  api,
  catalogEntries,
  login,
  modelCredit,
  requirePasswords,
  sellerEmail,
} from './demo-catalog/shared.mjs';

const AUDIT_WAIT_MS = 180_000;
const PUBLISHED = new Set(['APROBADO', 'PUBLICADA', 'EN_SUBASTA', 'CERRADO', 'VENDIDA']);

requirePasswords();

/** Sesion del vendedor; crea la cuenta la primera vez. */
async function sellerSession(key) {
  const email = sellerEmail(key);
  try {
    await api('POST', '/auth/register', { body: { email, password: SELLER_PASSWORD, displayName: SELLERS[key], role: 'SELLER', locale: 'es' } });
    console.log(`Cuenta creada: ${SELLERS[key]} (${email})`);
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
  }
  return login(email, SELLER_PASSWORD);
}

/** Cada tipo de obra sabe armar su ficha y conseguir sus archivos. */
const KINDS = {
  flat: FLAT_KIND,
  digital: DIGITAL_KIND,
  model: {
    fields: (work, files) => ({
      representationKind: 'THREE_D',
      categorySlug: work.category,
      widthCm: files.width,
      heightCm: files.height,
      depthCm: files.depth,
      provenance: modelCredit(work.asset, files.authors, work.lang),
    }),
    files: async (work) => {
      const asset = await fetchAsset(work.asset);
      return { ...asset, image: asset.render, contentType: 'image/jpeg' };
    },
  },
};

async function attachModel(token, lotId, glb) {
  const signed = await api('POST', `/lots/${lotId}/model-uploads`, { token, body: { contentType: 'model/gltf-binary' } });
  await uploadTo(signed.uploadUrl, 'model/gltf-binary', glb, 'el modelo');
  return api('POST', `/lots/${lotId}/model`, { token, body: { objectKey: signed.objectKey } });
}

async function waitForAudit(token, lotId) {
  const deadline = Date.now() + AUDIT_WAIT_MS;
  for (;;) {
    const lot = await api('GET', `/lots/${lotId}`, { token });
    if (lot.status !== 'PENDIENTE_AUDITORIA' || Date.now() > deadline) {
      return lot.status;
    }
    await sleep(1500);
  }
}

/** Publica una obra retomandola en el paso en que quedo. */
async function publish({ kind, work }, mine, seller, admin) {
  let lot = mine.find((item) => item.title === work.title) ?? null;
  if (lot && PUBLISHED.has(lot.status)) {
    return { status: lot.status, note: 'ya estaba publicada', skipped: true };
  }
  const needsFiles = !lot || lot.status === 'BORRADOR';
  const files = needsFiles ? await KINDS[kind].files(work) : null;
  if (!lot) {
    lot = await api('POST', '/lots', {
      token: seller,
      body: { title: work.title, description: work.description, materials: work.materials, ...KINDS[kind].fields(work, files) },
    });
  }
  if (lot.status === 'BORRADOR') {
    if (!lot.images?.length) {
      await attachImage(seller, lot.id, files.image, files.contentType);
    }
    if (kind === 'model' && !lot.model) {
      await attachModel(seller, lot.id, files.glb);
    }
    await api('POST', `/lots/${lot.id}/submit`, { token: seller });
  }
  let status = await waitForAudit(seller, lot.id);
  if (status === 'REVISION_MANUAL') {
    const [priceMin, priceMax] = work.price;
    await api('POST', `/admin/lots/${lot.id}/resolve`, { token: admin, body: { verdict: 'APROBADO', priceMin, priceMax } });
    status = (await api('GET', `/lots/${lot.id}`, { token: seller })).status;
    return { status, note: `aprobada por el administrador (${String(priceMin)}-${String(priceMax)})` };
  }
  return { status, note: 'aprobada por la auditoría: conserva el precio de la auditoría', selfApproved: true };
}

const only = process.env.DEMO_ONLY?.split(',').map((title) => title.trim());
const entries = catalogEntries().filter(({ work }) => !only || only.includes(work.title));
let admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
const sessions = new Map();
const owned = new Map();
for (const key of new Set(entries.map(({ work }) => work.seller))) {
  const token = await sellerSession(key);
  sessions.set(key, token);
  owned.set(key, await api('GET', '/lots/mine', { token }));
}

/** La carga dura mas que un token: ante un 401 renueva las sesiones y reintenta una vez. */
async function publishWithFreshSession(entry) {
  const { seller } = entry.work;
  try {
    return await publish(entry, owned.get(seller), sessions.get(seller), admin);
  } catch (error) {
    if (error.status !== 401) {
      throw error;
    }
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const token = await login(sellerEmail(seller), SELLER_PASSWORD);
    sessions.set(seller, token);
    owned.set(seller, await api('GET', '/lots/mine', { token }));
    return publish(entry, owned.get(seller), token, admin);
  }
}

const failed = [];
const selfApproved = [];
let done = 0;
for (const entry of entries) {
  const { work } = entry;
  done += 1;
  const prefix = `[${String(done)}/${String(entries.length)}] ${work.title}`;
  try {
    const result = await publishWithFreshSession(entry);
    console.log(`${prefix}: ${result.status}, ${result.note}`);
    if (result.selfApproved) {
      selfApproved.push(work.title);
    }
    if (!PUBLISHED.has(result.status)) {
      failed.push(work.title);
    }
  } catch (error) {
    failed.push(work.title);
    console.error(`${prefix}: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (selfApproved.length > 0) {
  console.warn(`Aprobadas sin pasar por el administrador (${String(selfApproved.length)}); revisa AUDIT_LOCAL_AUTO_APPROVE:`);
  console.warn(selfApproved.map((title) => `  - ${title}`).join('\n'));
}
if (failed.length > 0) {
  console.error(`${String(failed.length)} obra(s) sin publicar. Repite el comando: retoma donde quedo cada una.`);
  process.exit(1);
}
console.log(`Listo: ${String(entries.length)} obra(s) publicadas.`);
