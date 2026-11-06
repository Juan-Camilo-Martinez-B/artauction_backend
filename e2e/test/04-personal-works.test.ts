import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { call, createLotWithImage, eventually, register, type Account } from '../src/platform.ts';

interface LotView {
  id: string;
  status: string;
  visibility: string;
  authenticityScore: number | null;
  suggestedPriceMin: string | null;
}

interface Room {
  artworks: Array<{ lotId: string; lot: { title: string } }>;
}

interface Item {
  lotId: string;
  source: string;
  visibility: string;
}

// Proyectos propios: una cuenta cualquiera sube obras solo para su galeria, sin
// auditoria ni subasta, y decide si se ven en su galeria publica.
describe('explorar galerias', () => {
  test('una galeria publica se puede explorar, seguir y dejar de seguir', async () => {
    const author = await register('galerista', 'USER');
    const fan = await register('seguidora', 'USER');
    const fields = { title: 'E2E Obra de la galeria', description: 'Estudio a lapiz para probar la galeria publica.', materials: 'Lapiz sobre papel', categorySlug: 'otras', representationKind: 'TWO_D', widthCm: 20, heightCm: 30, destination: 'PERSONAL' };
    const lotId = await createLotWithImage(author, fields, 971);

    const empty = await call<{ workCount: number }>('GET', `/galleries/${author.userId}/summary`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.workCount, 0, 'un proyecto privado no cuenta');

    assert.equal((await call('PATCH', `/lots/${lotId}/visibility`, { token: author.token, body: { visibility: 'PUBLIC' } })).status, 200);
    await eventually('la obra queda colgada y marcada como publica', async () => {
      const room = await call<Room>('GET', `/galleries/${author.userId}/room`, { token: author.token });
      return room.status === 200 && room.body.artworks.some((artwork) => artwork.lotId === lotId);
    });
    // Una galeria es privada hasta que su autor la abre.
    assert.equal((await call('GET', `/galleries/${author.userId}/room`)).status, 404);
    assert.equal((await call('GET', `/galleries/${author.userId}/room`, { token: fan.token })).status, 404);
    assert.deepEqual((await call('GET', `/galleries/${author.userId}`)).body, []);
    assert.equal((await call<{ workCount: number }>('GET', `/galleries/${author.userId}/summary`)).body.workCount, 0);

    const opened = await call<{ visibility: string }>('PATCH', '/me/gallery/visibility', { token: author.token, body: { visibility: 'PUBLIC' } });
    assert.equal(opened.body.visibility, 'PUBLIC');
    assert.equal((await call('PATCH', '/me/gallery/visibility', { token: author.token, body: { visibility: 'OTRA' } })).status, 400);
    assert.equal((await call('PATCH', '/me/gallery/visibility', { body: { visibility: 'PUBLIC' } })).status, 401);
    const visit = await call<Room & { visibility: string; preferences?: unknown }>('GET', `/galleries/${author.userId}/room`);
    assert.equal(visit.status, 200);
    assert.equal(visit.body.artworks[0]?.lot.title, 'E2E Obra de la galeria');
    assert.equal(visit.body.preferences, undefined, 'los gustos que eligio su duena no salen a los visitantes');

    type Card = { ownerId: string; displayName: string; workCount: number; followerCount: number; previews: Array<{ lotId: string; previewUrl: string | null }> };
    const card = await eventually('la galeria aparece con su obra', async () => {
      const reply = await call<Card>('GET', `/galleries/${author.userId}/summary`);
      return reply.body.workCount === 1 ? reply.body : null;
    });
    assert.match(card.displayName, /galerista/);
    const [preview] = card.previews;
    assert.ok(preview);
    assert.equal(preview.lotId, lotId);
    assert.match(preview.previewUrl ?? '', /^https?:\/\//, 'la vista previa trae una URL que el navegador puede abrir');

    const page = await call<{ items: Card[]; total: number }>('GET', '/galleries?sort=recent&pageSize=24');
    assert.equal(page.status, 200);
    assert.ok(page.body.items.some((item) => item.ownerId === author.userId), 'la galeria mas reciente sale al explorar');

    assert.equal((await call('POST', `/users/${author.userId}/follow`, { token: fan.token })).status, 201);
    assert.deepEqual((await call<string[]>('GET', '/me/following', { token: fan.token })).body, [author.userId]);
    assert.equal((await call<Card>('GET', `/galleries/${author.userId}/summary`)).body.followerCount, 1);

    assert.equal((await call('DELETE', `/users/${author.userId}/follow`, { token: fan.token })).status, 200);
    assert.deepEqual((await call<string[]>('GET', '/me/following', { token: fan.token })).body, []);
    assert.equal((await call('GET', '/me/following')).status, 401, 'la lista de seguidos exige sesion');
  });
});

describe('proyectos propios', () => {
  let collector: Account;
  let seller: Account;
  let project: string;

  before(async () => {
    collector = await register('coleccionista', 'USER');
    seller = await register('autora', 'SELLER');
  });

  test('un coleccionista sube un proyecto propio: sin auditoria y colgado en su sala', async () => {
    const fields = { title: 'E2E Boceto del taller', description: 'Estudio a lapiz de las manos de un modelo del taller.', materials: 'Grafito sobre papel' };
    // Al catalogo solo publica quien vende.
    assert.equal((await call('POST', '/lots', { token: collector.token, body: { ...fields, categorySlug: 'pinturas', representationKind: 'TWO_D', widthCm: 30, heightCm: 40 } })).status, 403);

    project = await createLotWithImage(collector, { ...fields, destination: 'PERSONAL', widthCm: 30, heightCm: 40 }, 41);
    const lot = await call<LotView>('GET', `/lots/${project}`, { token: collector.token });
    assert.deepEqual(
      { status: lot.body.status, visibility: lot.body.visibility, score: lot.body.authenticityScore, price: lot.body.suggestedPriceMin },
      { status: 'PERSONAL', visibility: 'PRIVATE', score: null, price: null },
    );

    const room = await eventually('el proyecto se cuelga solo en la sala del autor', async () => {
      const mine = await call<Room>('GET', '/me/gallery', { token: collector.token });
      return mine.body.artworks.find((artwork) => artwork.lotId === project);
    });
    assert.equal(room.lot.title, 'E2E Boceto del taller', 'la sala no trae la ficha del proyecto privado');
    const mine = await call<LotView[]>('GET', '/lots/mine', { token: collector.token });
    assert.ok(mine.body.some((item) => item.id === project));
    // Un proyecto no se envia a auditoria desde una cuenta que no vende.
    assert.equal((await call('POST', `/lots/${project}/submit`, { token: collector.token })).status, 403);
  });

  test('el autor lo muestra en su galeria publica, pero nunca entra al catalogo', async () => {
    assert.equal((await call('GET', `/lots/${project}`)).status, 404, 'un proyecto privado no se ve sin sesion');
    assert.equal((await call('PATCH', `/lots/${project}/visibility`, { token: seller.token, body: { visibility: 'PUBLIC' } })).status, 404);
    const shown = await call<LotView>('PATCH', `/lots/${project}/visibility`, { token: collector.token, body: { visibility: 'PUBLIC' } });
    assert.equal(shown.body.visibility, 'PUBLIC');

    assert.equal((await call('PATCH', '/me/gallery/visibility', { token: collector.token, body: { visibility: 'PUBLIC' } })).status, 200);
    const listed = await eventually('la galeria publica muestra el proyecto', async () => {
      const items = await call<Item[]>('GET', `/galleries/${collector.userId}`);
      return items.body.find((item) => item.lotId === project);
    });
    assert.equal(listed.source, 'PROYECTO');
    assert.equal((await call<LotView>('GET', `/lots/${project}`)).body.status, 'PERSONAL', 'la ficha publica se abre desde la galeria');
    const catalog = await call<{ items: Array<{ id: string }> }>('GET', `/lots?q=${encodeURIComponent('E2E Boceto del taller')}`);
    assert.ok(!catalog.body.items.some((item) => item.id === project), 'un proyecto propio no se lista en el catalogo');

    // El autor lo sigue editando sin auditoria.
    const edited = await call<{ title: string }>('PATCH', `/lots/${project}`, {
      token: collector.token,
      body: { title: 'E2E Boceto corregido', description: 'Estudio a lapiz de las manos de un modelo del taller.', materials: 'Grafito sobre papel', categorySlug: 'pinturas', representationKind: 'TWO_D', widthCm: 30, heightCm: 40 },
    });
    assert.equal(edited.body.title, 'E2E Boceto corregido');
  });

  test('una vendedora pasa su proyecto al catalogo: se oculta y se audita', async () => {
    // El acrilico en 1910 es un anacronismo: una regla critica la manda a
    // revision manual sin consultar al modelo de IA. Esta prueba no mira el
    // veredicto, asi que no gasta la cuota gratuita del proveedor.
    const own = await createLotWithImage(
      seller,
      { title: 'E2E Marina propia', description: 'Marina pintada en el taller de la autora.', materials: 'Acrilico sobre lienzo', creationYear: 1910, destination: 'PERSONAL', visibility: 'PUBLIC' },
      42,
    );
    await eventually('el proyecto publico llega a su galeria', async () => {
      const items = await call<Item[]>('GET', `/galleries/${seller.userId}`, { token: seller.token });
      return items.body.some((item) => item.lotId === own && item.source === 'PROYECTO');
    });
    assert.equal((await call('POST', `/lots/${own}/submit`, { token: seller.token })).status, 201);
    const audited = await call<LotView>('GET', `/lots/${own}`, { token: seller.token });
    assert.ok(['PENDIENTE_AUDITORIA', 'PUBLICADA', 'REVISION_MANUAL'].includes(audited.body.status));

    const mine = await eventually('en la galeria deja de ser proyecto y se oculta mientras se audita', async () => {
      const items = await call<Item[]>('GET', `/galleries/${seller.userId}`, { token: seller.token });
      return items.body.find((item) => item.lotId === own && item.source === 'PROPIA');
    });
    // Privada mientras se audita; pasa a publica al entrar al catalogo, y la auditoria puede ser muy rapida.
    assert.ok(['PRIVATE', 'PUBLIC'].includes(mine.visibility));
    // Ya es una obra del catalogo: no se edita ni cambia de visibilidad a mano.
    assert.ok((await call('PATCH', `/lots/${own}/visibility`, { token: seller.token, body: { visibility: 'PUBLIC' } })).status >= 400);
  });
});
