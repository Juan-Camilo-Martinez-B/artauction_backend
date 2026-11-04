// Imagenes huerfanas del bucket: archivos bajo lots/<id>/ cuya obra ya no
// existe en catalog.lots (por ejemplo, tras borrar las obras de la e2e).
//
//   node scripts/storage/prune-orphan-images.mjs <ids-vivos.txt>           solo informa
//   node scripts/storage/prune-orphan-images.mjs <ids-vivos.txt> --delete  borra los huerfanos
//
// <ids-vivos.txt> tiene un id de obra por linea:
//   psql "$DATABASE_URL" -Atc "SELECT id FROM catalog.lots" > ids-vivos.txt
// Sin la lista completa todo pareceria huerfano: un archivo vacio se rechaza.
// Usa la llave de administracion de secrets/storage.env y nunca la imprime.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { DeleteObjectsCommand, ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');

const [liveFile, mode] = process.argv.slice(2);
if (!liveFile || (mode !== undefined && mode !== '--delete')) {
  console.error('Uso: node scripts/storage/prune-orphan-images.mjs <ids-vivos.txt> [--delete]');
  process.exit(1);
}
const live = new Set(
  readFileSync(liveFile, 'utf8')
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean),
);
if (live.size === 0) {
  console.error('La lista de obras vivas esta vacia: no se compara nada para no borrar todo el bucket.');
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(path.join(root, 'secrets/storage.env'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);
const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ADMIN_ACCESS_KEY_ID, secretAccessKey: env.S3_ADMIN_SECRET_ACCESS_KEY },
});

const objects = [];
let token;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: 'lots/', ContinuationToken: token }));
  objects.push(...(page.Contents ?? []));
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);

// lots/<id de la obra>/<archivo>: la obra es el segundo segmento.
const orphans = objects.filter((object) => !live.has(object.Key.split('/')[1] ?? ''));
const megabytes = orphans.reduce((sum, object) => sum + (object.Size ?? 0), 0) / 1024 / 1024;
console.log(`Archivos en lots/: ${String(objects.length)}`);
console.log(`Huerfanos: ${String(orphans.length)} archivos de ${String(new Set(orphans.map((object) => object.Key.split('/')[1])).size)} obras (${megabytes.toFixed(1)} MB)`);

if (mode !== '--delete') {
  if (orphans.length > 0) {
    console.log('Solo se informo. Para borrarlos, repite con --delete.');
  }
  process.exit(0);
}

let deleted = 0;
for (let start = 0; start < orphans.length; start += 1000) {
  const batch = orphans.slice(start, start + 1000).map((object) => ({ Key: object.Key }));
  const result = await client.send(new DeleteObjectsCommand({ Bucket: env.S3_BUCKET, Delete: { Objects: batch, Quiet: true } }));
  deleted += batch.length - (result.Errors?.length ?? 0);
  for (const error of result.Errors ?? []) {
    console.error(`No se borro ${error.Key}: ${error.Code}`);
  }
}
console.log(`Borrados: ${String(deleted)}`);
