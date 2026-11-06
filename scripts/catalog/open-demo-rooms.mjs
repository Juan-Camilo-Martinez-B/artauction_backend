// Llena y abre al publico las salas 3D de las cuentas de demostracion: cuelga todo
// lo publico de cada cuenta, le da una sala propia y reparte las obras con el mismo
// plan que el boton "Organizar" de Mi galeria.
//
//   npm run catalog:demo:rooms [-- aurora,lumen]
//
// Se puede repetir: reorganiza cada sala y descarta lo que se haya movido a mano.
// Lee el plan del frontend (Node ejecuta TypeScript sin compilar); si ese repo no
// esta al lado de este, indica su ruta en DEMO_FRONTEND_DIR.
// Usa las mismas variables DEMO_* que publish-demo-catalog.mjs.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SELLERS, SELLER_PASSWORD, api, login, readData, requirePasswords, sellerEmail } from './demo-catalog/shared.mjs';

const FRONTEND_DIR = process.env.DEMO_FRONTEND_DIR ?? resolve(import.meta.dirname, '../../../artauction_frontend');
const { artworkSize, hangingPlan, hasOverlaps, isObjectLot, roomOf } = await import(pathToFileURL(resolve(FRONTEND_DIR, 'src/lib/gallery/layout.ts')).href);

// Longitud de pared por obra colgada, contando el espacio entre obras, y el margen de las esquinas.
const WALL_METERS_PER_WORK = 2;
const CORNER_METERS = 7.2;
const MIN_ROOM = { roomWidth: 13, roomDepth: 9 };
// Con mas de 8 pedestales, la reticula necesita 3 filas para no apretarlos.
const MANY_OBJECTS_ROOM = { roomWidth: 16, roomDepth: 12 };
const MAX_ROOM = { roomWidth: 20, roomDepth: 16 };

/** La sala crece con lo que expone, con proporcion 4:3 y dentro de lo que acepta gallery-service. */
function roomFor(walls, objects) {
  const base = objects > 8 ? MANY_OBJECTS_ROOM : MIN_ROOM;
  const halfPerimeter = (walls * WALL_METERS_PER_WORK + CORNER_METERS) / 2;
  return {
    roomWidth: Math.min(MAX_ROOM.roomWidth, Math.max(base.roomWidth, Math.ceil((halfPerimeter * 4) / 7))),
    roomDepth: Math.min(MAX_ROOM.roomDepth, Math.max(base.roomDepth, Math.ceil((halfPerimeter * 3) / 7))),
  };
}

function configFor({ styleName, summary, palette, materials, lighting }, size) {
  return {
    schemaVersion: 1,
    source: 'manual',
    identity: { styleName, summary, artStyles: [] },
    architecture: { spaceType: 'MINIMAL', roomHeight: 4.5, zones: 1, ...size },
    palette,
    materials,
    lighting,
    navigation: { tour: 'libre', approach: 'ficha', motion: 'default' },
  };
}

requirePasswords();
const rooms = readData('rooms.json');
const only = process.argv[2]?.split(',');

for (const key of Object.keys(SELLERS).filter((seller) => !only || only.includes(seller))) {
  const token = await login(sellerEmail(key), SELLER_PASSWORD);
  const { ownerId } = await api('GET', '/me/gallery', { token });
  const items = await api('GET', `/galleries/${ownerId}`, { token });
  let skipped = 0;
  for (const item of items.filter((candidate) => candidate.visibility === 'PUBLIC')) {
    // Un objeto sin modelo 3D no se puede colgar; el resto de la sala sigue adelante.
    await api('POST', '/me/gallery/artworks', { token, body: { lotId: item.lotId } }).catch(() => {
      skipped += 1;
    });
  }
  const { artworks } = await api('GET', '/me/gallery', { token });
  const objects = artworks.filter((artwork) => isObjectLot(artwork.lot)).length;
  const size = roomFor(artworks.length - objects, objects);
  const config = configFor(rooms[key], size);
  await api('PATCH', '/me/gallery/config', { token, body: config });
  const plan = hangingPlan(
    artworks.map((artwork) => ({ id: artwork.id, size: artworkSize(artwork.lot), isObject: isObjectLot(artwork.lot) })),
    roomOf(config),
  );
  for (const artwork of artworks) {
    await api('PATCH', `/me/gallery/artworks/${artwork.lotId}`, { token, body: plan.get(artwork.id) });
  }
  await api('PATCH', '/me/gallery/visibility', { token, body: { visibility: 'PUBLIC' } });
  const overlapping = hasOverlaps(artworks.map((artwork) => ({ placement: plan.get(artwork.id), size: artworkSize(artwork.lot) })));
  console.log(`${key}: ${String(artworks.length)} obras (${String(objects)} objetos), sin colgar ${String(skipped)}, sala ${String(size.roomWidth)}x${String(size.roomDepth)}, encimadas ${String(overlapping)}`);
}
