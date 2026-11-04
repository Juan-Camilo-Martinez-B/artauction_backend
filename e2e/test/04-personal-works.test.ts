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
      const items = await call<Item[]>('GET', `/galleries/${seller.userId}`);
      return items.body.some((item) => item.lotId === own && item.source === 'PROYECTO');
    });
    assert.equal((await call('POST', `/lots/${own}/submit`, { token: seller.token })).status, 201);
    const audited = await call<LotView>('GET', `/lots/${own}`, { token: seller.token });
    assert.ok(['PENDIENTE_AUDITORIA', 'PUBLICADA', 'REVISION_MANUAL'].includes(audited.body.status));

    const mine = await eventually('en la galeria deja de ser proyecto y se oculta mientras se audita', async () => {
      const items = await call<Item[]>('GET', `/galleries/${seller.userId}`, { token: seller.token });
      return items.body.find((item) => item.lotId === own && item.source === 'PROPIA');
    });
    assert.equal(mine.visibility, 'PRIVATE');
    // Ya es una obra del catalogo: no se edita ni cambia de visibilidad a mano.
    assert.ok((await call('PATCH', `/lots/${own}/visibility`, { token: seller.token, body: { visibility: 'PUBLIC' } })).status >= 400);
  });
});
