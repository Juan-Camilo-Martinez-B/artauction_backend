import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// Utilidades de la prueba de punta a punta. Todo pasa por el gateway, como lo
// usa el frontend: nada de esto lee bases de datos ni llama a servicios internos.

export const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3001';
const PASSWORD = 'E2ePassword!2026';
const SEED_PASSWORD = process.env['E2E_SEED_PASSWORD'] ?? 'DevPassword!234';
/** Sufijo de esta corrida: los usuarios nuevos no chocan con corridas anteriores. */
export const RUN_ID = randomUUID().slice(0, 8);

export interface Reply<T = unknown> {
  status: number;
  body: T;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  options: { token?: string | undefined; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply<T>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Respuesta que no es JSON (por ejemplo HTML); se devuelve como texto.
  }
  return { status: response.status, body: body as T };
}

export interface Account {
  email: string;
  token: string;
  userId: string;
}

async function login(email: string, password: string): Promise<Account> {
  const tokens = await call<{ accessToken: string }>('POST', '/auth/login', { body: { email, password } });
  if (tokens.status !== 200) {
    throw new Error(`login de ${email} respondio ${String(tokens.status)}`);
  }
  const me = await call<{ userId: string }>('GET', '/auth/me', { token: tokens.body.accessToken });
  return { email, token: tokens.body.accessToken, userId: me.body.userId };
}

/** Registra una cuenta nueva de esta corrida y entra con ella. */
export async function register(name: string, role: 'USER' | 'SELLER'): Promise<Account> {
  const email = `e2e-${name}-${RUN_ID}@artauction.test`;
  const created = await call('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: `E2E ${name}`, role } });
  if (created.status !== 201) {
    throw new Error(`registro de ${email} respondio ${String(created.status)}: ${JSON.stringify(created.body)}`);
  }
  return login(email, PASSWORD);
}

/** Cuentas de la semilla de artauction_bd que no se pueden crear por la API. */
export function seedAccount(email: string): Promise<Account> {
  return login(email, SEED_PASSWORD);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Repite hasta que `check` devuelva un valor, o falla al vencer el plazo. */
export async function eventually<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`no se cumplio a tiempo: ${label}`);
    }
    await sleep(1_000);
  }
}

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Generador pseudoaleatorio mulberry32: la misma semilla da la misma imagen. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const BLOCK_PX = 75;

/**
 * PNG RGB generado en memoria: una cuadricula de bloques de luminancia
 * aleatoria con un grano fino encima. El hash perceptual mira la estructura de
 * baja frecuencia, asi que son los bloques los que hacen distinta cada imagen;
 * cambiar solo los colores no basta para que la auditoria no la vea duplicada.
 */
export function texturedPng(width: number, height: number, seed: number): Buffer {
  const random = randomFrom(seed);
  const columns = Math.ceil(width / BLOCK_PX);
  const blocks = Array.from({ length: columns * Math.ceil(height / BLOCK_PX) }, () => [random(), random(), random()] as const);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [light, warm, cool] = blocks[Math.floor(y / BLOCK_PX) * columns + Math.floor(x / BLOCK_PX)] ?? [0, 0, 0];
      const grain = (x * 7 + y * 13) % 24;
      const offset = 1 + x * 3;
      // Canales separados por bloque: una saturacion realista para una pintura.
      row[offset] = Math.min(255, Math.floor(light * 120 + warm * 120) + grain);
      row[offset + 1] = Math.min(255, Math.floor(light * 150) + grain);
      row[offset + 2] = Math.min(255, Math.floor(light * 90 + cool * 150) + grain);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Publica una obra completa: alta, hash, subida firmada a Garage, registro de la imagen y envio a auditoria. */
export async function publishLot(seller: Account, fields: Record<string, unknown>, seed: number): Promise<string> {
  const created = await call<{ id: string }>('POST', '/lots', {
    token: seller.token,
    body: { categorySlug: 'pinturas', representationKind: 'TWO_D', widthCm: 120, heightCm: 90, ...fields },
  });
  if (created.status !== 201) {
    throw new Error(`alta de obra respondio ${String(created.status)}: ${JSON.stringify(created.body)}`);
  }
  const lotId = created.body.id;
  // La corrida entra en la semilla: con una imagen repetida entre corridas, la
  // auditoria detectaria un duplicado de otro vendedor y no publicaria la obra.
  const image = texturedPng(1200, 900, Math.imul(seed, 0x9e3779b1) ^ Number.parseInt(RUN_ID, 16));
  const hash = await call<{ perceptualHash: string }>('POST', `/lots/${lotId}/hash`, { token: seller.token, body: { imageBase64: image.toString('base64') } });
  const signed = await call<{ uploadUrl: string; objectKey: string }>('POST', `/lots/${lotId}/uploads`, {
    token: seller.token,
    body: { contentType: 'image/png', position: 0 },
  });
  const upload = await fetch(signed.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array(image) });
  if (!upload.ok) {
    throw new Error(`subida a Garage respondio ${String(upload.status)}`);
  }
  await call('POST', `/lots/${lotId}/images`, {
    token: seller.token,
    body: { objectKey: signed.body.objectKey, position: 0, perceptualHash: hash.body.perceptualHash },
  });
  const submitted = await call('POST', `/lots/${lotId}/submit`, { token: seller.token });
  if (submitted.status !== 201) {
    throw new Error(`envio a auditoria respondio ${String(submitted.status)}`);
  }
  return lotId;
}
