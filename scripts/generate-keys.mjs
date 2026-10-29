// Genera los secretos locales de los microservicios en secrets/ (no versionado):
//   secrets/jwt/private.pem   clave privada RS256, solo la lee identity-service
//   secrets/jwt/public.pem    clave publica, la leen el gateway y los servicios
//   secrets/service-clients.env  secreto de cada cliente de servicio y la linea
//                                SERVICE_CLIENTS (id:sha256) para identity-service
// No sobrescribe archivos existentes salvo con --force.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICES = [
  'api-gateway',
  'catalog-service',
  'auction-service',
  'wallet-service',
  'audit-service',
  'gallery-service',
  'notification-service',
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = path.join(root, 'secrets');
const force = process.argv.includes('--force');

function write(file, content, mode = 0o600) {
  if (existsSync(file) && !force) {
    console.log(`keep ${path.relative(root, file)}`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode });
  console.log(`write ${path.relative(root, file)}`);
}

const privatePath = path.join(secrets, 'jwt', 'private.pem');
if (!existsSync(privatePath) || force) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  write(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  // La clave publica no es secreta: legible por todos, la leen los contenedores
  // (usuario node) aunque el archivo pertenezca a otro usuario del host.
  write(path.join(secrets, 'jwt', 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }), 0o644);
} else {
  console.log('keep secrets/jwt/private.pem');
}

const clientsPath = path.join(secrets, 'service-clients.env');
const lines = ['# Secretos de cliente de cada servicio. No compartir ni versionar.'];
const digests = [];
for (const service of SERVICES) {
  const secret = randomBytes(32).toString('base64url');
  const variable = `${service.replace(/-/g, '_').toUpperCase()}_CLIENT_SECRET`;
  lines.push(`${variable}=${secret}`);
  digests.push(`${service}:${createHash('sha256').update(secret).digest('hex')}`);
}
lines.push('', '# Para identity-service: solo huellas, nunca los secretos.', `SERVICE_CLIENTS=${digests.join(',')}`, '');
write(clientsPath, lines.join('\n'));

// Secretos del nodo Garage (almacenamiento S3 de imagenes).
write(
  path.join(secrets, 'garage.env'),
  [
    '# Secretos del nodo Garage. No compartir ni versionar.',
    `GARAGE_RPC_SECRET=${randomBytes(32).toString('hex')}`,
    `GARAGE_ADMIN_TOKEN=${randomBytes(32).toString('base64url')}`,
    '',
  ].join('\n'),
);
