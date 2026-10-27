// Fija la politica CORS del bucket de imagenes: el navegador sube con PUT
// directo al bucket desde los origenes del frontend. Usa la llave de
// administracion de secrets/storage.env.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = require('@aws-sdk/client-s3');

const env = Object.fromEntries(
  readFileSync(path.join(root, 'secrets/storage.env'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);

const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((origin) => origin.trim());
const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ADMIN_ACCESS_KEY_ID, secretAccessKey: env.S3_ADMIN_SECRET_ACCESS_KEY },
});

await client.send(
  new PutBucketCorsCommand({
    Bucket: env.S3_BUCKET,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          AllowedHeaders: ['content-type'],
          ExposeHeaders: ['etag'],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  }),
);
const applied = await client.send(new GetBucketCorsCommand({ Bucket: env.S3_BUCKET }));
console.log(`CORS aplicado para ${applied.CORSRules?.[0]?.AllowedOrigins?.join(', ')}`);
