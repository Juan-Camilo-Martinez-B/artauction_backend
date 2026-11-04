import { DomainError, isRecord } from '@artauction/platform';

// Lectura de un modelo GLB (glTF 2.0 binario, el formato que exporta Blender)
// sin decodificar su geometria: la cabecera y el bloque JSON bastan para medir
// triangulos, vertices y la caja que lo envuelve, porque glTF exige el conteo
// de cada accessor y el minimo y maximo de las posiciones. Asi funciona igual
// con geometria comprimida (Draco o meshopt). Todo lo que viene del archivo se
// trata como dato no confiable: se acota antes de usarlo.

export const MODEL_LIMITS = {
  /** La sala 3D debe cargar rapido. */
  maxBytes: 30 * 1024 * 1024,
  /** Menos que esto es un esbozo, no una pieza. */
  minTriangles: 1_000,
  /** Mas que esto vuelve lenta la sala en un telefono. */
  maxTriangles: 300_000,
  maxJsonBytes: 4 * 1024 * 1024,
  maxNodes: 10_000,
} as const;

/** Extensiones que la sala sabe abrir sin pedir nada a internet. */
const SUPPORTED_REQUIRED = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_mesh_quantization',
  'KHR_texture_transform',
]);

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

export interface ModelSize {
  x: number;
  y: number;
  z: number;
}

export interface GlbReport {
  triangles: number;
  vertices: number;
  /** Caja que envuelve el modelo, en sus unidades (Blender exporta metros). */
  size: ModelSize;
}

type Json = Record<string, unknown>;
type Matrix = number[];

function invalid(message: string): DomainError {
  return DomainError.invalid(`El modelo 3D no es valido: ${message}`);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : -1;
}

function numbers(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return null;
  }
  return value as number[];
}

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Producto de matrices 4x4 en el orden de columnas de glTF. */
function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Matriz local de un nodo: la que trae, o traslacion, rotacion y escala. */
function localMatrix(node: Json): Matrix {
  const matrix = numbers(node['matrix'], 16);
  if (matrix) {
    return matrix;
  }
  const [tx, ty, tz] = numbers(node['translation'], 3) ?? [0, 0, 0];
  const [qx, qy, qz, qw] = numbers(node['rotation'], 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = numbers(node['scale'], 3) ?? [1, 1, 1];
  const [x, y, z, w] = [qx ?? 0, qy ?? 0, qz ?? 0, qw ?? 1];
  return [
    (1 - 2 * (y * y + z * z)) * (sx ?? 1), 2 * (x * y + z * w) * (sx ?? 1), 2 * (x * z - y * w) * (sx ?? 1), 0,
    2 * (x * y - z * w) * (sy ?? 1), (1 - 2 * (x * x + z * z)) * (sy ?? 1), 2 * (y * z + x * w) * (sy ?? 1), 0,
    2 * (x * z + y * w) * (sz ?? 1), 2 * (y * z - x * w) * (sz ?? 1), (1 - 2 * (x * x + y * y)) * (sz ?? 1), 0,
    tx ?? 0, ty ?? 0, tz ?? 0, 1,
  ];
}

function transform(matrix: Matrix, point: [number, number, number]): [number, number, number] {
  const [x, y, z] = point;
  return [
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0),
  ];
}

/** Lee el bloque JSON de un GLB y comprueba su cabecera. */
function readJson(bytes: Uint8Array): Json {
  if (bytes.byteLength > MODEL_LIMITS.maxBytes) {
    throw invalid('pesa mas de 30 MB.');
  }
  if (bytes.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) {
    throw invalid('el archivo es demasiado corto.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw invalid('no es un archivo GLB. Exporta desde Blender como glTF binario (.glb).');
  }
  if (view.getUint32(4, true) !== 2) {
    throw invalid('solo se admite glTF 2.0.');
  }
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw invalid('el archivo esta incompleto o tiene datos de mas.');
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || jsonLength > MODEL_LIMITS.maxJsonBytes || HEADER_BYTES + CHUNK_HEADER_BYTES + jsonLength > bytes.byteLength) {
    throw invalid('la descripcion del modelo esta danada.');
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    if (!isRecord(parsed)) {
      throw new Error('no es un objeto');
    }
    return parsed;
  } catch {
    throw invalid('la descripcion del modelo no es JSON.');
  }
}

/** Todo debe venir dentro del archivo: nada de texturas o geometria en otra URL. */
function assertSelfContained(gltf: Json): void {
  for (const buffer of list(gltf['buffers'])) {
    if (isRecord(buffer) && buffer['uri'] !== undefined) {
      throw invalid('usa archivos externos. Exportalo como .glb para que todo quede dentro.');
    }
  }
  for (const image of list(gltf['images'])) {
    if (isRecord(image) && image['uri'] !== undefined) {
      throw invalid('sus texturas estan fuera del archivo. Exportalo como .glb con las texturas incluidas.');
    }
  }
  for (const extension of list(gltf['extensionsRequired'])) {
    if (typeof extension !== 'string' || !SUPPORTED_REQUIRED.has(extension)) {
      throw invalid(`necesita la extension ${String(extension)}, que la sala no puede abrir.`);
    }
  }
}

interface MeshMeasure {
  triangles: number;
  vertices: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** Triangulos, vertices y caja de una malla, segun sus accessors. */
function measureMesh(mesh: unknown, accessors: unknown[]): MeshMeasure | null {
  if (!isRecord(mesh)) {
    return null;
  }
  const result: MeshMeasure = { triangles: 0, vertices: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const primitive of list(mesh['primitives'])) {
    if (!isRecord(primitive) || !isRecord(primitive['attributes'])) {
      continue;
    }
    const position = accessors[count(primitive['attributes']['POSITION'])];
    if (!isRecord(position)) {
      continue;
    }
    const positions = count(position['count']);
    const min = numbers(position['min'], 3);
    const max = numbers(position['max'], 3);
    if (positions < 0 || !min || !max) {
      throw invalid('una de sus mallas no declara sus posiciones como exige glTF.');
    }
    const indices = primitive['indices'] === undefined ? undefined : accessors[count(primitive['indices'])];
    const drawn = isRecord(indices) ? count(indices['count']) : positions;
    if (drawn < 0) {
      throw invalid('una de sus mallas tiene indices danados.');
    }
    const mode = primitive['mode'] === undefined ? 4 : count(primitive['mode']);
    // 4 = triangulos sueltos; 5 y 6 = tiras y abanicos. Puntos y lineas no tienen caras.
    result.triangles += mode === 4 ? Math.floor(drawn / 3) : mode === 5 || mode === 6 ? Math.max(0, drawn - 2) : 0;
    result.vertices += positions;
    for (let axis = 0; axis < 3; axis += 1) {
      result.min[axis] = Math.min(result.min[axis] as number, min[axis] as number);
      result.max[axis] = Math.max(result.max[axis] as number, max[axis] as number);
    }
  }
  return result.vertices > 0 ? result : null;
}

/**
 * Mide un GLB y lo valida: glTF 2.0 binario, autocontenido, con extensiones que
 * la sala soporta y con triangulos dentro de los limites. Cada malla cuenta
 * tantas veces como aparece en la escena, y su caja se lleva al mundo con la
 * transformacion de sus nodos.
 */
export function inspectGlb(bytes: Uint8Array): GlbReport {
  const gltf = readJson(bytes);
  const version = isRecord(gltf['asset']) ? gltf['asset']['version'] : undefined;
  if (typeof version !== 'string' || !version.startsWith('2')) {
    throw invalid('solo se admite glTF 2.0.');
  }
  assertSelfContained(gltf);

  const nodes = list(gltf['nodes']);
  const meshes = list(gltf['meshes']);
  const accessors = list(gltf['accessors']);
  if (nodes.length > MODEL_LIMITS.maxNodes) {
    throw invalid('tiene demasiados nodos.');
  }
  const scenes = list(gltf['scenes']);
  const scene = scenes[count(gltf['scene']) >= 0 ? count(gltf['scene']) : 0];
  const roots = isRecord(scene) ? list(scene['nodes']) : nodes.map((_node, index) => index);

  let triangles = 0;
  let vertices = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const measured = new Map<number, MeshMeasure | null>();
  // Recorrido iterativo con tope de visitas: un archivo con ciclos no cuelga el servicio.
  const stack: Array<{ index: number; parent: Matrix; depth: number }> = roots.map((index) => ({ index: count(index), parent: IDENTITY, depth: 0 }));
  let visits = 0;
  while (stack.length > 0) {
    const { index, parent, depth } = stack.pop() as { index: number; parent: Matrix; depth: number };
    visits += 1;
    if (visits > MODEL_LIMITS.maxNodes || depth > 64) {
      throw invalid('su jerarquia de nodos es demasiado profunda o tiene ciclos.');
    }
    const node = nodes[index];
    if (!isRecord(node)) {
      continue;
    }
    const world = multiply(parent, localMatrix(node));
    const meshIndex = count(node['mesh']);
    if (meshIndex >= 0) {
      if (!measured.has(meshIndex)) {
        measured.set(meshIndex, measureMesh(meshes[meshIndex], accessors));
      }
      const mesh = measured.get(meshIndex);
      if (mesh) {
        triangles += mesh.triangles;
        vertices += mesh.vertices;
        for (const cx of [mesh.min[0], mesh.max[0]]) {
          for (const cy of [mesh.min[1], mesh.max[1]]) {
            for (const cz of [mesh.min[2], mesh.max[2]]) {
              const point = transform(world, [cx, cy, cz]);
              for (let axis = 0; axis < 3; axis += 1) {
                min[axis] = Math.min(min[axis] as number, point[axis] as number);
                max[axis] = Math.max(max[axis] as number, point[axis] as number);
              }
            }
          }
        }
      }
    }
    for (const child of list(node['children'])) {
      stack.push({ index: count(child), parent: world, depth: depth + 1 });
    }
  }

  if (triangles < MODEL_LIMITS.minTriangles) {
    throw invalid(`tiene ${String(triangles)} triangulos; el minimo es ${String(MODEL_LIMITS.minTriangles)}.`);
  }
  if (triangles > MODEL_LIMITS.maxTriangles) {
    throw invalid(`tiene ${String(triangles)} triangulos; el maximo es ${String(MODEL_LIMITS.maxTriangles)}. Reducelo con el modificador Decimate de Blender.`);
  }
  const size = { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
  if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > 0)) {
    throw invalid('no tiene volumen.');
  }
  return { triangles, vertices, size };
}
