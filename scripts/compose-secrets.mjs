// Prepara los secretos que necesita el docker compose y que no genera
// generate-keys.mjs: la contrasena del superusuario de Postgres, la de cada
// login de servicio y el secreto de revalidacion del frontend. Crea
// secrets/compose.env si no existe y, si existe, solo agrega las variables que le
// falten (por ejemplo, la de un servicio nuevo); nunca reemplaza secretos ya
// emitidos. Las claves RS256, los secretos de cliente y los de Garage siguen
// saliendo de generate-keys.mjs.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = path.join(root, 'secrets');
const SERVICES = ['identity', 'catalog', 'auction', 'wallet', 'audit', 'gallery', 'notification'];

const required = ['jwt/private.pem', 'jwt/public.pem', 'service-clients.env', 'garage.env'];
const missing = required.filter((file) => !existsSync(path.join(secrets, file)));
if (missing.length > 0) {
  console.error(`Faltan secretos (${missing.join(', ')}). Ejecuta antes: node scripts/generate-keys.mjs`);
  process.exit(1);
}

const file = path.join(secrets, 'compose.env');
const password = () => randomBytes(24).toString('base64url');
const variables = ['POSTGRES_PASSWORD', ...SERVICES.map((service) => `${service.toUpperCase()}_DB_PASSWORD`), 'REVALIDATE_SECRET'];

if (!existsSync(file)) {
  mkdirSync(secrets, { recursive: true });
  const lines = ['# Secretos del docker compose. No compartir ni versionar.', ...variables.map((name) => `${name}=${password()}`), ''];
  writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  console.log('write secrets/compose.env');
} else {
  // Solo interesan los nombres: los valores existentes no se tocan ni se imprimen.
  const present = new Set(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.split('=')[0].trim())
      .filter((name) => name && !name.startsWith('#')),
  );
  const absent = variables.filter((name) => !present.has(name));
  if (absent.length === 0) {
    console.log('keep secrets/compose.env');
  } else {
    const content = readFileSync(file, 'utf8');
    const separator = content.endsWith('\n') ? '' : '\n';
    appendFileSync(file, separator + absent.map((name) => `${name}=${password()}\n`).join(''));
    console.log(`add to secrets/compose.env: ${absent.join(', ')}`);
  }
}
