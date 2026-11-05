// Descarga de modelos 3D CC0 de Poly Haven y empaquetado en GLB, sin dependencias.
// Lo comparten las cargas del catalogo; importarlo no tiene efectos.
import path from 'node:path';

const POLY_HAVEN_API = 'https://api.polyhaven.com';

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`descarga de ${url} respondio ${String(response.status)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Nombre de archivo de una referencia del glTF, sin carpeta ni codificacion. */
function fileName(uri) {
  return path.posix.basename(decodeURIComponent(uri));
}

/**
 * Empaqueta un glTF con sus archivos externos (buffers e imagenes) en un GLB:
 * todo va a un unico bloque binario alineado a 4 bytes y cada imagen pasa a
 * leerse de su propio bufferView. Catalog solo acepta GLB autocontenidos.
 */
export function packGlb(gltf, files) {
  const chunks = [];
  let length = 0;
  const append = (data) => {
    const start = length;
    chunks.push(data);
    length += data.length;
    const pad = (4 - (length % 4)) % 4;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad));
      length += pad;
    }
    return start;
  };
  const need = (uri) => {
    const data = files.get(fileName(uri));
    if (!data) {
      throw new Error(`falta el archivo ${uri} del modelo`);
    }
    return data;
  };

  const bases = gltf.buffers.map((buffer) => append(need(buffer.uri)));
  for (const view of gltf.bufferViews) {
    view.byteOffset = (view.byteOffset ?? 0) + bases[view.buffer];
    view.buffer = 0;
  }
  for (const image of gltf.images ?? []) {
    if (!image.uri) {
      continue;
    }
    const data = need(image.uri);
    gltf.bufferViews.push({ buffer: 0, byteOffset: append(data), byteLength: data.length });
    image.bufferView = gltf.bufferViews.length - 1;
    image.mimeType = /\.png$/i.test(image.uri) ? 'image/png' : 'image/jpeg';
    delete image.uri;
  }
  const bin = Buffer.concat(chunks);
  gltf.buffers = [{ byteLength: bin.length }];

  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunkHeader = (size, type) => {
    const out = Buffer.alloc(8);
    out.writeUInt32LE(size, 0);
    out.writeUInt32LE(type, 4);
    return out;
  };
  return Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(bin.length, 0x004e4942), bin]);
}

/** Ficha, render y GLB de un modelo de Poly Haven. */
export async function fetchAsset(asset) {
  const [info, files] = await Promise.all([download(`${POLY_HAVEN_API}/info/${asset}`), download(`${POLY_HAVEN_API}/files/${asset}`)]);
  const meta = JSON.parse(info.toString('utf8'));
  const entry = JSON.parse(files.toString('utf8')).gltf?.['1k']?.gltf;
  if (!entry) {
    throw new Error(`Poly Haven no ofrece glTF 1k de ${asset}`);
  }
  const companions = new Map();
  await Promise.all(
    Object.entries(entry.include ?? {}).map(async ([reference, file]) => {
      companions.set(fileName(reference), await download(file.url));
    }),
  );
  const gltf = JSON.parse((await download(entry.url)).toString('utf8'));
  const render = await download(`https://cdn.polyhaven.com/asset_img/thumbs/${asset}.png?width=1000&height=1000&format=jpg`);
  // Poly Haven mide en milimetros con Z hacia arriba: [ancho, fondo, alto].
  const [width, depth, height] = meta.dimensions.map((mm) => Math.round(mm) / 10);
  return { glb: packGlb(gltf, companions), render, width, depth, height, authors: Object.keys(meta.authors ?? {}) };
}
