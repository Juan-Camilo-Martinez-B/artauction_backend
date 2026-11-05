// Despliega el backend en Azure Container Apps: una app por servicio, con gRPC
// por la red interna del entorno y solo el gateway visible desde fuera.
//
//   node scripts/deploy/azure.mjs secrets   genera los secretos de produccion
//   node scripts/deploy/azure.mjs infra     grupo de recursos, registro y entorno
//   node scripts/deploy/azure.mjs images    construye y publica las imagenes
//   node scripts/deploy/azure.mjs apps      crea o actualiza las apps
//
// Todos los pasos se pueden repetir. Los secretos viven en secrets/production
// (no versionado) y las contrasenas de la base en ../artauction_bd/.env.supabase.
//
// Variables de `apps`:
//   DEPLOY_LOAD_MODE=1   sin modelo de IA y sin aprobacion automatica, para la
//                        carga del catalogo de demostracion
//   FRONTEND_ORIGIN      origen del frontend que el gateway debe aceptar
//   DEPLOY_ONLY          lista de apps, para actualizar solo esas
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SECRETS = path.join(ROOT, 'secrets', 'production');
const SUPABASE_ENV = path.resolve(ROOT, '../artauction_bd/.env.supabase');
const PUBLISHED_TAG_FILE = path.join(SECRETS, 'image-tag');
const AZ = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd';

const RESOURCE_GROUP = 'artauction-prod';
const LOCATION = 'canadacentral';
const ENVIRONMENT = 'artauction-env';
const REGISTRY = 'artauctionprod';
const REGISTRY_SERVER = `${REGISTRY}.azurecr.io`;
const PUSH_ATTEMPTS = 5;
const ENVIRONMENT_API_VERSION = '2025-10-02-preview';
const APP_API_VERSION = '2025-01-01';
const CLIENTS = ['api-gateway', 'catalog-service', 'auction-service', 'wallet-service', 'audit-service', 'gallery-service', 'notification-service'];

// Direccion interna de un servicio: el proxy del entorno escucha en el puerto 80.
const grpcUrl = (service) => `${service}:80`;

const SMALL = { cpu: 0.25, memory: '0.5Gi' };

/** Lo que distingue a cada servicio. El resto de la configuracion es comun. */
const SERVICES = {
  'identity-service': { port: 50051, schema: 'identity', clientSecret: false, privateKey: true, env: () => ({ SERVICE_CLIENTS: secret('SERVICE_CLIENTS') }) },
  'catalog-service': {
    port: 50052,
    schema: 'catalog',
    env: ({ storage }) => ({
      GALLERY_EVENTS_GRPC_URL: grpcUrl('gallery-service'),
      AUDIT_EVENTS_GRPC_URL: grpcUrl('audit-service'),
      AUCTION_EVENTS_GRPC_URL: grpcUrl('auction-service'),
      NOTIFICATION_EVENTS_GRPC_URL: grpcUrl('notification-service'),
      AI_GRPC_URL: grpcUrl('ai-service'),
      TRANSLATION_ENABLED: 'true',
      S3_ENDPOINT: storage.S3_ENDPOINT,
      S3_REGION: storage.S3_REGION,
      S3_BUCKET: storage.S3_BUCKET,
      S3_ACCESS_KEY_ID: secret('S3_ACCESS_KEY_ID'),
      S3_SECRET_ACCESS_KEY: secret('S3_SECRET_ACCESS_KEY'),
      MEDIA_PUBLIC_BASE_URL: storage.MEDIA_PUBLIC_BASE_URL,
    }),
  },
  'wallet-service': { port: 50053, schema: 'wallet', env: () => ({ AUCTION_GRPC_URL: grpcUrl('auction-service') }) },
  'auction-service': {
    port: 50054,
    schema: 'auction',
    env: () => ({
      CATALOG_GRPC_URL: grpcUrl('catalog-service'),
      WALLET_GRPC_URL: grpcUrl('wallet-service'),
      GALLERY_EVENTS_GRPC_URL: grpcUrl('gallery-service'),
      NOTIFICATION_EVENTS_GRPC_URL: grpcUrl('notification-service'),
    }),
  },
  'ai-service': {
    port: 50055,
    resources: { cpu: 1, memory: '2Gi' },
    // Debian (glibc): el runtime ONNX del traductor no corre en Alpine.
    nodeImage: 'node:24-bookworm-slim',
    env: ({ loadMode }) => ({
      TRANSLATION_ENABLED: 'true',
      TRANSLATION_CACHE_DIR: '/tmp/models',
      GROQ_API_KEY: loadMode ? '' : secret('GROQ_API_KEY'),
    }),
  },
  'audit-service': {
    port: 50056,
    schema: 'audit',
    env: ({ storage, loadMode }) => ({
      CATALOG_GRPC_URL: grpcUrl('catalog-service'),
      AI_GRPC_URL: grpcUrl('ai-service'),
      AUCTION_EVENTS_GRPC_URL: grpcUrl('auction-service'),
      NOTIFICATION_EVENTS_GRPC_URL: grpcUrl('notification-service'),
      MEDIA_PUBLIC_BASE_URL: storage.MEDIA_PUBLIC_BASE_URL,
      MEDIA_INTERNAL_BASE_URL: storage.MEDIA_PUBLIC_BASE_URL,
      AUDIT_LOCAL_AUTO_APPROVE: loadMode ? 'false' : 'true',
    }),
  },
  'gallery-service': { port: 50057, schema: 'gallery', env: () => ({ CATALOG_GRPC_URL: grpcUrl('catalog-service'), AI_GRPC_URL: grpcUrl('ai-service') }) },
  'notification-service': { port: 50058, schema: 'notification', clientSecret: false, env: () => ({}) },
  'api-gateway': {
    port: 3001,
    external: true,
    env: ({ frontendOrigin }) => ({
      PORT: '3001',
      CORS_ORIGINS: frontendOrigin,
      CATALOG_GRPC_URL: grpcUrl('catalog-service'),
      WALLET_GRPC_URL: grpcUrl('wallet-service'),
      AUCTION_GRPC_URL: grpcUrl('auction-service'),
      AUDIT_GRPC_URL: grpcUrl('audit-service'),
      GALLERY_GRPC_URL: grpcUrl('gallery-service'),
      NOTIFICATION_GRPC_URL: grpcUrl('notification-service'),
    }),
  },
};

/** Marca un valor para guardarlo como secreto de la app en vez de como texto. */
const secret = (name) => ({ secretName: name });

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readEnvFile(file) {
  if (!existsSync(file)) {
    fail(`Falta ${path.relative(ROOT, file)}`);
  }
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

/** Ejecuta la CLI de Azure. La salida se analiza como JSON, ignorando lo que imprima la consola. */
function az(...args) {
  const result = spawnSync('cmd.exe', ['/d', '/c', AZ, ...args, '--only-show-errors', '-o', 'json'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
  if (result.status !== 0) {
    fail(`az ${args.slice(0, 3).join(' ')} fallo:\n${result.stderr.slice(-1500)}`);
  }
  const start = result.stdout.search(/^[[{"]/m);
  return start < 0 ? null : JSON.parse(result.stdout.slice(start));
}

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'], input, windowsHide: true });
  if (result.status !== 0) {
    fail(`${command} ${args.slice(0, 2).join(' ')} fallo`);
  }
}

function writeSecrets() {
  mkdirSync(SECRETS, { recursive: true });
  const keyFile = path.join(SECRETS, 'jwt-private.pem');
  if (!existsSync(keyFile)) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(path.join(SECRETS, 'jwt-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    console.log('Claves JWT de produccion creadas');
  }
  const clientsFile = path.join(SECRETS, 'service-clients.env');
  if (!existsSync(clientsFile)) {
    const lines = [];
    const digests = [];
    for (const client of CLIENTS) {
      const value = randomBytes(32).toString('base64url');
      lines.push(`${client.replaceAll('-', '_').toUpperCase()}_CLIENT_SECRET=${value}`);
      digests.push(`${client}:${createHash('sha256').update(value).digest('hex')}`);
    }
    lines.push(`SERVICE_CLIENTS=${digests.join(',')}`, '');
    writeFileSync(clientsFile, lines.join('\n'), { mode: 0o600 });
    console.log('Secretos de cliente creados');
  }
  const demoFile = path.join(SECRETS, 'demo.env');
  if (!existsSync(demoFile)) {
    const lines = ['DEMO_ADMIN_EMAIL=admin@artauction.app', `DEMO_ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}`, `DEMO_SELLER_PASSWORD=${randomBytes(18).toString('base64url')}`, 'DEMO_EMAIL_DOMAIN=artauction.app', ''];
    writeFileSync(demoFile, lines.join('\n'), { mode: 0o600 });
    console.log('Contrasenas del administrador y de los vendedores creadas');
  }
  const storageFile = path.join(SECRETS, 'storage.env');
  if (!existsSync(storageFile)) {
    const ref = /postgres\.([a-z0-9]+):/.exec(readEnvFile(SUPABASE_ENV).DATABASE_URL)?.[1];
    const lines = [
      '# Almacenamiento en Supabase Storage. Copia las claves de Storage > S3 Configuration.',
      `S3_ENDPOINT=https://${ref}.storage.supabase.co/storage/v1/s3`,
      'S3_REGION=us-east-1',
      'S3_BUCKET=artauction-media',
      'S3_ACCESS_KEY_ID=REEMPLAZA_ESTO',
      'S3_SECRET_ACCESS_KEY=REEMPLAZA_ESTO',
      `MEDIA_PUBLIC_BASE_URL=https://${ref}.supabase.co/storage/v1/object/public/artauction-media`,
      '',
    ];
    writeFileSync(storageFile, lines.join('\n'), { mode: 0o600 });
    console.log('Plantilla de almacenamiento creada');
  }
}

function createInfrastructure() {
  az('config', 'set', 'extension.use_dynamic_install=yes_without_prompt');
  for (const provider of ['Microsoft.App', 'Microsoft.ContainerRegistry']) {
    az('provider', 'register', '-n', provider, '--wait');
    console.log(`Proveedor registrado: ${provider}`);
  }
  az('group', 'create', '-n', RESOURCE_GROUP, '-l', LOCATION);
  console.log(`Grupo de recursos: ${RESOURCE_GROUP} (${LOCATION})`);
  az('acr', 'create', '-n', REGISTRY, '-g', RESOURCE_GROUP, '-l', LOCATION, '--sku', 'Basic', '--admin-enabled', 'true');
  console.log(`Registro de imagenes: ${REGISTRY_SERVER}`);
  createEnvironment();
  console.log(`Entorno: ${ENVIRONMENT}`);
}

/**
 * El modo va explicito: sin el, Azure crea un entorno express, que no admite
 * HTTP/2 ni gRPC. Se usa la API porque la CLI aun no ofrece esa opcion.
 */
function createEnvironment() {
  const resource = `/subscriptions/{subscriptionId}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/${ENVIRONMENT}?api-version=${ENVIRONMENT_API_VERSION}`;
  const body = path.join(SECRETS, 'environment.json');
  writeFileSync(
    body,
    JSON.stringify({
      location: LOCATION,
      properties: { environmentMode: 'WorkloadProfiles', workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }] },
    }),
  );
  try {
    az('rest', '--method', 'put', '--uri', resource, '--body', `@${body}`);
  } finally {
    rmSync(body, { force: true });
  }
  for (;;) {
    const state = az('rest', '--method', 'get', '--uri', resource, '--query', 'properties.provisioningState');
    if (state === 'Succeeded') {
      return;
    }
    if (state === 'Failed') {
      fail('Azure no pudo crear el entorno');
    }
    spawnSync('cmd.exe', ['/d', '/c', 'timeout', '/t', '10', '/nobreak'], { stdio: 'ignore', windowsHide: true });
  }
}

function imageTag() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.stdout.trim();
}

function registryCredentials() {
  const credentials = az('acr', 'credential', 'show', '-n', REGISTRY);
  return { username: credentials.username, password: credentials.passwords[0].value };
}

/** Las capas pesan cientos de MB: un corte de red no debe obligar a empezar de cero. */
function pushWithRetries(image) {
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    const result = spawnSync('docker', ['push', '-q', image], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    if (result.status === 0) {
      return;
    }
    console.log(`Reintento ${String(attempt)} de ${String(PUSH_ATTEMPTS)}: ${image}`);
  }
  fail(`No se pudo publicar ${image}`);
}

function publishImages() {
  const { username, password } = registryCredentials();
  run('docker', ['login', REGISTRY_SERVER, '-u', username, '--password-stdin'], password);
  const tag = imageTag();
  for (const [name, service] of Object.entries(SERVICES)) {
    const image = `${REGISTRY_SERVER}/${name}:${tag}`;
    console.log(`Imagen ${image}`);
    const args = ['build', '-q', '--platform', 'linux/amd64', '--build-arg', `SERVICE=${name}`, '-t', image];
    if (service.nodeImage) {
      args.push('--build-arg', `NODE_IMAGE=${service.nodeImage}`);
    }
    run('docker', [...args, '.']);
    pushWithRetries(image);
  }
  // Las apps usan lo publicado, no el ultimo commit: puede no tener imagen.
  writeFileSync(PUBLISHED_TAG_FILE, tag);
}

/** Configuracion completa de un servicio, con cada secreto separado del texto. */
function appDefinition(name, service, context) {
  const { database, clients, storage, jwtPublic, jwtPrivate, environmentId, registry, tag, groqKey } = context;
  const values = {
    NODE_ENV: 'production',
    GRPC_HOST: '0.0.0.0',
    GRPC_TLS: 'false',
    JWT_PUBLIC_KEY_PATH: '/run/secrets/jwt/public.pem',
    IDENTITY_GRPC_URL: grpcUrl('identity-service'),
    ...(service.external ? {} : { GRPC_PORT: String(service.port) }),
    ...(service.privateKey ? { JWT_PRIVATE_KEY_PATH: '/run/secrets/jwt/private.pem' } : {}),
    ...service.env(context),
  };
  const secrets = new Map([['acr-password', registry.password], ['jwt-public', jwtPublic]]);
  if (service.privateKey) {
    secrets.set('jwt-private', jwtPrivate);
  }
  if (service.schema) {
    const password = database[`${service.schema.toUpperCase()}_DB_PASSWORD`];
    const url = new URL(database.DATABASE_URL);
    url.username = `${service.schema}_svc.${url.username.split('.')[1]}`;
    url.password = password;
    url.search = `?schema=${service.schema}&sslmode=require&connection_limit=2`;
    secrets.set('database-url', url.toString());
    values.DATABASE_URL = secret('database-url');
  }
  if (service.schema && service.clientSecret !== false) {
    values.SERVICE_CLIENT_ID = name;
    secrets.set('service-client-secret', clients[`${name.replaceAll('-', '_').toUpperCase()}_CLIENT_SECRET`]);
    values.SERVICE_CLIENT_SECRET = secret('service-client-secret');
  }
  const secretValues = { SERVICE_CLIENTS: clients.SERVICE_CLIENTS, S3_ACCESS_KEY_ID: storage.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: storage.S3_SECRET_ACCESS_KEY, GROQ_API_KEY: groqKey };
  const env = Object.entries(values).map(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      const secretName = value.secretName.toLowerCase().replaceAll('_', '-');
      if (!secrets.has(secretName)) {
        secrets.set(secretName, secretValues[value.secretName]);
      }
      return { name: key, secretRef: secretName };
    }
    return { name: key, value };
  });
  const jwtFiles = [{ secretRef: 'jwt-public', path: 'public.pem' }, ...(service.privateKey ? [{ secretRef: 'jwt-private', path: 'private.pem' }] : [])];
  return {
    location: LOCATION,
    name,
    properties: {
      managedEnvironmentId: environmentId,
      configuration: {
        activeRevisionsMode: 'Single',
        registries: [{ server: REGISTRY_SERVER, username: registry.username, passwordSecretRef: 'acr-password' }],
        secrets: [...secrets].map(([secretName, value]) => ({ name: secretName, value })),
        ingress: service.external
          ? { external: true, targetPort: service.port, transport: 'auto' }
          : { external: false, targetPort: service.port, transport: 'http2', allowInsecure: true },
      },
      template: {
        containers: [
          {
            name,
            image: `${REGISTRY_SERVER}/${name}:${tag}`,
            env,
            resources: service.resources ?? SMALL,
            volumeMounts: [{ volumeName: 'jwt', mountPath: '/run/secrets/jwt' }],
          },
        ],
        // Una sola replica: las salas en vivo guardan estado en memoria.
        scale: { minReplicas: 1, maxReplicas: 1 },
        volumes: [{ name: 'jwt', storageType: 'Secret', secrets: jwtFiles }],
      },
    },
  };
}

function deployApps() {
  const storage = readEnvFile(path.join(SECRETS, 'storage.env'));
  if (storage.S3_ACCESS_KEY_ID === 'REEMPLAZA_ESTO' || storage.S3_SECRET_ACCESS_KEY === 'REEMPLAZA_ESTO') {
    fail('Faltan las claves S3 en secrets/production/storage.env');
  }
  const loadMode = process.env.DEPLOY_LOAD_MODE === '1';
  const groqKey = readEnvFile(path.join(ROOT, 'services/ai-service/.env')).GROQ_API_KEY ?? '';
  if (!loadMode && !groqKey) {
    fail('Falta GROQ_API_KEY en services/ai-service/.env');
  }
  const environmentId = az('containerapp', 'env', 'show', '-n', ENVIRONMENT, '-g', RESOURCE_GROUP).id;
  const context = {
    database: readEnvFile(SUPABASE_ENV),
    clients: readEnvFile(path.join(SECRETS, 'service-clients.env')),
    storage,
    jwtPublic: readFileSync(path.join(SECRETS, 'jwt-public.pem'), 'utf8'),
    jwtPrivate: readFileSync(path.join(SECRETS, 'jwt-private.pem'), 'utf8'),
    environmentId,
    registry: registryCredentials(),
    tag: readFileSync(PUBLISHED_TAG_FILE, 'utf8').trim(),
    groqKey,
    loadMode,
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  };
  const only = process.env.DEPLOY_ONLY?.split(',').map((name) => name.trim());
  const rendered = path.join(SECRETS, 'rendered');
  mkdirSync(rendered, { recursive: true });
  try {
    for (const [name, service] of Object.entries(SERVICES)) {
      if (only && !only.includes(name)) {
        continue;
      }
      const file = path.join(rendered, `${name}.json`);
      writeFileSync(file, JSON.stringify(appDefinition(name, service, context)), { mode: 0o600 });
      // PUT sirve igual para crear y para actualizar, y envia la definicion sin reinterpretarla.
      const resource = `/subscriptions/{subscriptionId}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/containerApps/${name}?api-version=${APP_API_VERSION}`;
      const app = az('rest', '--method', 'put', '--uri', resource, '--body', `@${file}`);
      console.log(`${name}: ${app?.properties?.provisioningState ?? 'enviada'}${service.external ? ` https://${app?.properties?.configuration?.ingress?.fqdn}` : ''}`);
    }
  } finally {
    rmSync(rendered, { recursive: true, force: true });
  }
}

const { positionals } = parseArgs({ allowPositionals: true });
const steps = { secrets: writeSecrets, infra: createInfrastructure, images: publishImages, apps: deployApps };
const step = steps[positionals[0]];
if (!step) {
  fail(`Uso: node scripts/deploy/azure.mjs ${Object.keys(steps).join('|')}`);
}
step();
