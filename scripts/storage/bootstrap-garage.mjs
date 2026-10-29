// Inicializa Garage desde el docker compose usando su API de administracion v2
// (la imagen de Garage no trae shell, asi que la CLI no sirve aqui). Idempotente:
//   1. Asigna capacidad al nodo y aplica el layout si todavia no tiene rol.
//   2. Crea el bucket de imagenes y habilita su lectura publica.
//   3. Crea la llave de catalog-service con lectura y escritura SOLO de ese bucket.
//   3b. Fija CORS con S3 PutBucketCors y una llave de administracion del bucket:
//       Garage v2.1 no acepta corsRules en su API de administracion.
//       El SDK de AWS se toma de catalog-service, cuya imagen ejecuta este script.
//   4. Escribe las credenciales de catalog en un volumen interno, legibles solo
//      por el usuario de los servicios (uid 1000), nunca en la imagen ni en git.
import { chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ADMIN_URL = process.env.GARAGE_ADMIN_URL ?? 'http://garage:3903';
const TOKEN = process.env.GARAGE_ADMIN_TOKEN;
const BUCKET = process.env.S3_BUCKET ?? 'artauction-media';
const KEY_NAME = 'catalog-service';
const ADMIN_KEY_NAME = 'storage-admin';
const S3_ENDPOINT = process.env.S3_INTERNAL_ENDPOINT ?? 'http://garage:3900';
const SDK_FROM = process.env.AWS_SDK_FROM ?? '/app/services/catalog-service/package.json';
const OUT = process.env.STORAGE_ENV_PATH ?? '/bootstrap/storage.env';
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((origin) => origin.trim());
const CAPACITY_BYTES = 2_000_000_000;
const SERVICE_UID = 1000;

if (!TOKEN) {
  console.error('GARAGE_ADMIN_TOKEN es obligatorio');
  process.exit(1);
}

async function api(method, operation, { query, body } = {}) {
  const url = new URL(`/v2/${operation}`, ADMIN_URL);
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, json: text ? JSON.parse(text) : null };
}

async function must(method, operation, options) {
  const result = await api(method, operation, options);
  if (!result.ok) {
    throw new Error(`${operation} respondio ${String(result.status)}: ${JSON.stringify(result.json)}`);
  }
  return result.json;
}

async function waitForGarage() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const status = await api('GET', 'GetClusterStatus');
      if (status.ok && status.json.nodes.length > 0) {
        return status.json;
      }
    } catch {
      // Garage aun no acepta conexiones.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Garage no respondio a tiempo');
}

const status = await waitForGarage();
const layout = await must('GET', 'GetClusterLayout');
if (layout.roles.length === 0) {
  const nodeId = status.nodes[0].id;
  await must('POST', 'UpdateClusterLayout', { body: { roles: [{ id: nodeId, zone: 'dc1', capacity: CAPACITY_BYTES, tags: [] }] } });
  await must('POST', 'ApplyClusterLayout', { body: { version: layout.version + 1 } });
  console.log(`layout aplicado en ${nodeId.slice(0, 16)}`);
} else {
  console.log('layout ya configurado');
}

// Sin un 404 documentado para un alias desconocido, solo un 200 con el alias cuenta como existente.
async function findBucket() {
  const result = await api('GET', 'GetBucketInfo', { query: { globalAlias: BUCKET } });
  return result.ok && result.json?.globalAliases?.includes(BUCKET) ? result.json : null;
}
let bucket = await findBucket();
if (!bucket) {
  const created = await api('POST', 'CreateBucket', { body: { globalAlias: BUCKET } });
  bucket = created.ok ? created.json : await findBucket();
  if (!bucket) {
    throw new Error(`no se pudo crear el bucket ${BUCKET}`);
  }
  console.log(`bucket ${BUCKET} creado`);
}
await must('POST', 'UpdateBucket', {
  query: { id: bucket.id },
  body: { websiteAccess: { enabled: true, indexDocument: 'index.html' } },
});

async function ensureKey(name, permissions) {
  const found = await api('GET', 'GetKeyInfo', { query: { search: name, showSecretKey: true } });
  let key = found.ok && found.json?.name === name ? found.json : null;
  if (!key) {
    const created = await must('POST', 'CreateKey', { body: { name } });
    key = await must('GET', 'GetKeyInfo', { query: { id: created.accessKeyId, showSecretKey: true } });
    console.log(`llave ${name} creada`);
  }
  await must('POST', 'AllowBucketKey', { body: { bucketId: bucket.id, accessKeyId: key.accessKeyId, permissions } });
  if (!key.secretAccessKey) {
    throw new Error(`Garage no devolvio el secreto de la llave ${name}`);
  }
  return key;
}
const key = await ensureKey(KEY_NAME, { read: true, write: true });
const adminKey = await ensureKey(ADMIN_KEY_NAME, { read: true, write: true, owner: true });

const require = createRequire(SDK_FROM);
const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: 'garage',
  forcePathStyle: true,
  credentials: { accessKeyId: adminKey.accessKeyId, secretAccessKey: adminKey.secretAccessKey },
});
await s3.send(
  new PutBucketCorsCommand({
    Bucket: BUCKET,
    CORSConfiguration: {
      CORSRules: [
        { AllowedOrigins: CORS_ORIGINS, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type'], ExposeHeaders: ['etag'], MaxAgeSeconds: 3000 },
      ],
    },
  }),
);
console.log(`CORS fijado para ${CORS_ORIGINS.join(', ')}`);

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  [
    '# Credenciales S3 de catalog-service, generadas por bootstrap-garage. No compartir.',
    `S3_ACCESS_KEY_ID=${key.accessKeyId}`,
    `S3_SECRET_ACCESS_KEY=${key.secretAccessKey}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
chownSync(OUT, SERVICE_UID, SERVICE_UID);
console.log('credenciales de catalog listas');
