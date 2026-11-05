// Publica en el catalogo obras tridimensionales de muestra con su modelo 3D
// real. Reemplazan a las esculturas, jarrones y relojes de la semilla, que solo
// tenian foto: desde F16 un objeto se expone unicamente con su modelo.
//
//   npm run catalog:sample-3d
//
// Los modelos son de Poly Haven (polyhaven.com), con licencia CC0. Por cada
// obra el script descarga el glTF (1k) y su render, empaqueta el glTF con su
// buffer y sus texturas en un solo GLB (sin dependencias), y la publica como el
// vendedor de la semilla con el mismo recorrido que el frontend: alta, imagen,
// modelo y envio a auditoria. Si la auditoria la deja en revision manual, la
// aprueba el administrador de la semilla con un rango de precio fijo.
//
// Es idempotente: una obra con el mismo titulo del mismo vendedor se retoma en
// el paso en que quedo y una ya publicada no se toca.
//
// Variables (todas opcionales; los valores por omision son los de desarrollo):
//   SAMPLE_API_URL       gateway, por omision http://127.0.0.1:3001
//   SAMPLE_SELLER_EMAIL  vendedor, por omision seller@artauction.local
//   SAMPLE_ADMIN_EMAIL   administrador, por omision admin@artauction.local
//   SEED_PASSWORD        contrasena local de la semilla de artauction_bd
// Se niega a correr con NODE_ENV=production.
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchAsset } from './poly-haven.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('No se cargan obras de muestra con NODE_ENV=production.');
  process.exit(1);
}

const API = process.env.SAMPLE_API_URL ?? 'http://127.0.0.1:3001';
const SELLER_EMAIL = process.env.SAMPLE_SELLER_EMAIL ?? 'seller@artauction.local';
const ADMIN_EMAIL = process.env.SAMPLE_ADMIN_EMAIL ?? 'admin@artauction.local';
const PASSWORD = process.env.SEED_PASSWORD ?? 'DevPassword!234';
const AUDIT_WAIT_MS = 180_000;
const PUBLISHED = new Set(['APROBADO', 'PUBLICADA', 'EN_SUBASTA', 'CERRADO', 'VENDIDA']);

/**
 * Obras de muestra. Las medidas no se escriben aqui: salen de Poly Haven (la
 * caja real del modelo), asi la auditoria no ve proporciones que no cuadran.
 * Los precios son el rango que fija el administrador si la auditoria no lo
 * estima.
 */
const WORKS = [
  {
    asset: 'gothic_statue',
    title: 'Estatua gótica con corona y cadenas',
    description:
      'Figura de tamaño natural, envuelta en un manto y con velo, que lleva corona, pesadas cadenas, un libro y una espada. La piedra conserva musgo, desgaste y bordes astillados, y descansa sobre una base tallada con detalle.',
    materials: 'Piedra tallada con pátina y musgo',
    category: 'escultura',
    price: [2400, 3600],
  },
  {
    asset: 'bronze_whale_statue',
    title: 'Ballena de bronce',
    description: 'Escultura de una ballena en pleno salto, fundida en bronce con pátina oscura y reflejos dorados en las zonas más pulidas.',
    materials: 'Bronce patinado',
    category: 'escultura',
    price: [1500, 2200],
  },
  {
    asset: 'marble_bust_01',
    title: 'Busto de mármol de un hombre joven',
    description: 'Busto de estilo clásico de un hombre joven de cabello corto y rizado, tallado en mármol claro sobre un pie torneado.',
    materials: 'Mármol',
    category: 'escultura',
    price: [900, 1400],
  },
  {
    asset: 'lion_head',
    title: 'Cabeza de león',
    description: 'Cabeza de león de melena abundante y expresión serena, pensada como relieve decorativo para un muro o una fuente.',
    materials: 'Piedra moldeada',
    category: 'escultura',
    price: [700, 1100],
  },
  {
    asset: 'horse_statue_01',
    title: 'Caballo encabritado de porcelana',
    description: 'Figura de porcelana blanca de un caballo alzado sobre las patas traseras, con la crin al viento, sobre una peana de madera.',
    materials: 'Porcelana esmaltada y madera',
    category: 'escultura',
    price: [300, 500],
  },
  {
    asset: 'concrete_cat_statue',
    title: 'Gato sentado',
    description: 'Gato sentado en actitud vigilante, vaciado en concreto, con la textura y las manchas propias de una pieza de jardín.',
    materials: 'Concreto vaciado',
    category: 'escultura',
    price: [250, 400],
  },
  {
    asset: 'carved_wooden_elephant',
    title: 'Elefante tallado en madera',
    description: 'Pequeño elefante tallado a mano en madera, con la trompa baja y las marcas de la gubia a la vista.',
    materials: 'Madera tallada',
    category: 'objetos-artisticos',
    price: [120, 200],
  },
  {
    asset: 'antique_ceramic_vase_01',
    title: 'Jarrón antiguo de cerámica',
    description: 'Jarrón de cuerpo ovalado y cuello corto, de cerámica con esmalte gastado y pequeñas pérdidas en el borde.',
    materials: 'Cerámica esmaltada',
    category: 'ceramica',
    price: [600, 900],
  },
  {
    asset: 'brass_vase_01',
    title: 'Jarrón alto de latón',
    description: 'Jarrón esbelto de latón, de cuello largo y abocinado, vientre bulboso y pie alto, con la pátina oscura de los años.',
    materials: 'Latón',
    category: 'objetos-artisticos',
    price: [450, 700],
  },
  {
    asset: 'ceramic_vase_02',
    title: 'Jarrón de cerámica',
    description: 'Jarrón de cerámica torneada, de líneas sencillas y esmalte uniforme.',
    materials: 'Cerámica esmaltada',
    category: 'ceramica',
    price: [200, 350],
  },
  {
    asset: 'mantel_clock_01',
    title: 'Reloj de chimenea',
    description: 'Reloj de sobremesa para repisa de chimenea, con caja de madera barnizada, esfera clara y detalles metálicos.',
    materials: 'Madera barnizada, metal y vidrio',
    category: 'objetos-artisticos',
    price: [800, 1200],
  },
  {
    asset: 'vintage_grandfather_clock_01',
    title: 'Reloj de pie antiguo',
    description: 'Reloj de pie de caja alta en madera, con esfera, péndulo a la vista y remate tallado.',
    materials: 'Madera, metal y vidrio',
    category: 'objetos-artisticos',
    price: [1800, 2600],
  },
];

async function api(method, route, { token, body } = {}) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${route} respondio ${String(response.status)}: ${data?.message ?? text}`);
  }
  return data;
}

async function login(email) {
  const session = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  return session.accessToken;
}

async function uploadImage(token, lotId, render) {
  const { perceptualHash } = await api('POST', `/lots/${lotId}/hash`, { token, body: { imageBase64: render.toString('base64') } });
  const signed = await api('POST', `/lots/${lotId}/uploads`, { token, body: { contentType: 'image/jpeg', position: 0 } });
  const put = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(render) });
  if (!put.ok) {
    throw new Error(`subida de la imagen respondio ${String(put.status)}`);
  }
  await api('POST', `/lots/${lotId}/images`, { token, body: { objectKey: signed.objectKey, position: 0, perceptualHash } });
}

async function uploadModel(token, lotId, glb) {
  const signed = await api('POST', `/lots/${lotId}/model-uploads`, { token, body: { contentType: 'model/gltf-binary' } });
  const put = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'content-type': 'model/gltf-binary' }, body: new Uint8Array(glb) });
  if (!put.ok) {
    throw new Error(`subida del modelo respondio ${String(put.status)}`);
  }
  return api('POST', `/lots/${lotId}/model`, { token, body: { objectKey: signed.objectKey } });
}

async function waitForAudit(token, lotId) {
  const deadline = Date.now() + AUDIT_WAIT_MS;
  for (;;) {
    const lot = await api('GET', `/lots/${lotId}`, { token });
    if (lot.status !== 'PENDIENTE_AUDITORIA' || Date.now() > deadline) {
      return lot.status;
    }
    await sleep(2000);
  }
}

/** Publica una obra retomandola en el paso en que quedo. Devuelve su estado final. */
async function publish(work, mine, seller, admin) {
  let lot = mine.find((item) => item.title === work.title) ?? null;
  if (lot && PUBLISHED.has(lot.status)) {
    return { status: lot.status, note: 'ya estaba publicada' };
  }
  const asset = await fetchAsset(work.asset);
  if (!lot) {
    lot = await api('POST', '/lots', {
      token: seller,
      body: {
        title: work.title,
        description: work.description,
        materials: work.materials,
        categorySlug: work.category,
        representationKind: 'THREE_D',
        widthCm: asset.width,
        heightCm: asset.height,
        depthCm: asset.depth,
        provenance: `Modelo 3D CC0 de Poly Haven (polyhaven.com/a/${work.asset})${asset.authors.length ? `, por ${asset.authors.join(' y ')}` : ''}.`,
      },
    });
  }
  if (lot.status === 'BORRADOR') {
    if (!lot.images?.length) {
      await uploadImage(seller, lot.id, asset.render);
    }
    const model = lot.model ?? (await uploadModel(seller, lot.id, asset.glb));
    console.log(`  modelo: ${model.triangleCount.toLocaleString('es-CO')} triángulos, ${(asset.glb.length / 1048576).toFixed(1)} MB`);
    await api('POST', `/lots/${lot.id}/submit`, { token: seller });
  }
  let status = await waitForAudit(seller, lot.id);
  let note = 'publicada por la auditoría';
  if (status === 'REVISION_MANUAL') {
    const [priceMin, priceMax] = work.price;
    await api('POST', `/admin/lots/${lot.id}/resolve`, { token: admin, body: { verdict: 'APROBADO', priceMin, priceMax } });
    status = (await api('GET', `/lots/${lot.id}`, { token: seller })).status;
    note = `aprobada por el administrador (${String(priceMin)}-${String(priceMax)})`;
  }
  return { status, note };
}

const seller = await login(SELLER_EMAIL);
const admin = await login(ADMIN_EMAIL);
const mine = await api('GET', '/lots/mine', { token: seller });
let failures = 0;
for (const work of WORKS) {
  console.log(`${work.title} (${work.asset})`);
  try {
    const result = await publish(work, mine, seller, admin);
    console.log(`  ${result.status}: ${result.note}`);
  } catch (error) {
    failures += 1;
    console.error(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failures > 0) {
  console.error(`${String(failures)} obra(s) no se publicaron. Repite el comando: retoma donde quedo cada una.`);
  process.exit(1);
}
