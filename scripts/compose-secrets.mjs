// Prepara los secretos que necesita el docker compose y que no genera
// generate-keys.mjs: la contrasena del superusuario de Postgres, la de cada
// login de servicio y el secreto de revalidacion del frontend. Solo crea
// secrets/compose.env si no existe; nunca reemplaza secretos ya emitidos. Las
// claves RS256, los secretos de cliente y los de Garage siguen saliendo de
// generate-keys.mjs.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = path.join(root, 'secrets');
const SERVICES = ['identity', 'catalog', 'auction', 'wallet', 'audit', 'gallery'];

const required = ['jwt/private.pem', 'jwt/public.pem', 'service-clients.env', 'garage.env'];
const missing = required.filter((file) => !existsSync(path.join(secrets, file)));
if (missing.length > 0) {
  console.error(`Faltan secretos (${missing.join(', ')}). Ejecuta antes: node scripts/generate-keys.mjs`);
  process.exit(1);
}

const file = path.join(secrets, 'compose.env');
if (existsSync(file)) {
  console.log('keep secrets/compose.env');
} else {
  mkdirSync(secrets, { recursive: true });
  const password = () => randomBytes(24).toString('base64url');
  const lines = [
    '# Secretos del docker compose. No compartir ni versionar.',
    `POSTGRES_PASSWORD=${password()}`,
    ...SERVICES.map((service) => `${service.toUpperCase()}_DB_PASSWORD=${password()}`),
    `REVALIDATE_SECRET=${password()}`,
    '',
  ];
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  console.log('write secrets/compose.env');
}
