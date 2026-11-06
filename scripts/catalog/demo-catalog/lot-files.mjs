// Ficha y archivos de las obras planas de demostracion (de museo o generativas),
// y su subida por el mismo recorrido que usa el frontend.
import { renderArt } from './generate-art.mjs';
import { SELLERS, api, digitalCredit, flatCredit } from './shared.mjs';

const AIC_HEADERS = { 'AIC-User-Agent': 'artauction-demo-catalog' };
// Lado de la pieza generativa al exponerla: no es un objeto fisico.
const DIGITAL_SIDE_CM = 70;

export async function download(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`descarga de ${url} respondio ${String(response.status)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export const FLAT_KIND = {
  fields: (work) => ({
    artistName: work.artist ?? undefined,
    creationYear: work.year ?? undefined,
    representationKind: 'TWO_D',
    categorySlug: work.category,
    widthCm: work.widthCm,
    heightCm: work.heightCm,
    provenance: flatCredit(work, work.lang),
  }),
  files: async (work) => ({
    image: await download(`https://www.artic.edu/iiif/2/${work.imageId}/full/843,/0/default.jpg`, AIC_HEADERS),
    contentType: 'image/jpeg',
  }),
};

export const DIGITAL_KIND = {
  fields: (work) => ({
    artistName: SELLERS[work.seller],
    creationYear: new Date().getUTCFullYear(),
    representationKind: 'TWO_D',
    categorySlug: 'arte-digital',
    widthCm: DIGITAL_SIDE_CM,
    heightCm: DIGITAL_SIDE_CM,
    provenance: digitalCredit(work.lang),
  }),
  files: async (work) => ({ image: renderArt(work.art), contentType: 'image/png' }),
};

export async function uploadTo(uploadUrl, contentType, data, label) {
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(data) });
  if (!put.ok) {
    throw new Error(`subida de ${label} respondio ${String(put.status)}`);
  }
}

export async function attachImage(token, lotId, image, contentType) {
  const { perceptualHash } = await api('POST', `/lots/${lotId}/hash`, { token, body: { imageBase64: image.toString('base64') } });
  const signed = await api('POST', `/lots/${lotId}/uploads`, { token, body: { contentType, position: 0 } });
  await uploadTo(signed.uploadUrl, contentType, image, 'la imagen');
  await api('POST', `/lots/${lotId}/images`, { token, body: { objectKey: signed.objectKey, position: 0, perceptualHash } });
}
