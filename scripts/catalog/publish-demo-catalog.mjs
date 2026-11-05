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
import { renderArt } from './demo-catalog/generate-art.mjs';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  SELLERS,
  SELLER_PASSWORD,
  api,
  catalogEntries,
  digitalCredit,
  flatCredit,
  login,
  modelCredit,
  requirePasswords,
  sellerEmail,
} from './demo-catalog/shared.mjs';

const AIC_HEADERS = { 'AIC-User-Agent': 'artauction-demo-catalog' };
const AUDIT_WAIT_MS = 180_000;
const PUBLISHED = new Set(['APROBADO', 'PUBLICADA', 'EN_SUBASTA', 'CERRADO', 'VENDIDA']);
// Lado de la pieza generativa al exponerla: no es un objeto fisico.
const DIGITAL_SIDE_CM = 70;

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

async function download(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`descarga de ${url} respondio ${String(response.status)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Cada tipo de obra sabe armar su ficha y conseguir sus archivos. */
const KINDS = {
  flat: {
    fields: (work) => ({
      artistName: work.artist ?? undefined,
      creationYear: work.year ?? undefined,
      representationKind: 'TWO_D',
      categorySlug: work.category,
      widthCm: work.widthCm,
      heightCm: work.heightCm,
      provenance: flatCredit(work, work.lang),
    }),
    files: async (work) => ({
      image: await download(`https://www.artic.edu/iiif/2/${work.imageId}/full/843,/0/default.jpg`, AIC_HEADERS),
      contentType: 'image/jpeg',
    }),
  },
  digital: {
    fields: (work) => ({
      artistName: SELLERS[work.seller],
      creationYear: new Date().getUTCFullYear(),
      representationKind: 'TWO_D',
      categorySlug: 'arte-digital',
      widthCm: DIGITAL_SIDE_CM,
      heightCm: DIGITAL_SIDE_CM,
      provenance: digitalCredit(work.lang),
    }),
    files: async (work) => ({ image: renderArt(work.art), contentType: 'image/png' }),
  },
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

async function uploadTo(uploadUrl, contentType, data, label) {
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(data) });
  if (!put.ok) {
    throw new Error(`subida de ${label} respondio ${String(put.status)}`);
  }
}

async function attachImage(token, lotId, image, contentType) {
  const { perceptualHash } = await api('POST', `/lots/${lotId}/hash`, { token, body: { imageBase64: image.toString('base64') } });
  const signed = await api('POST', `/lots/${lotId}/uploads`, { token, body: { contentType, position: 0 } });
  await uploadTo(signed.uploadUrl, contentType, image, 'la imagen');
  await api('POST', `/lots/${lotId}/images`, { token, body: { objectKey: signed.objectKey, position: 0, perceptualHash } });
}

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
