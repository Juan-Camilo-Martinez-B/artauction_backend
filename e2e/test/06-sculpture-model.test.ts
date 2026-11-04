import assert from 'node:assert/strict';
import { get } from 'node:http';
import { before, describe, test } from 'node:test';
import { call, createLotWithImage, eventually, register, seedAccount, uploadModel, vaseGlb, type Account } from '../src/platform.ts';

interface ModelView {
  url: string | null;
  bytes: number;
  triangleCount: number;
  vertexCount: number;
  size: { x: number; y: number; z: number };
}

interface LotView {
  id: string;
  status: string;
  model: ModelView | null;
}

interface ReviewItem {
  lot: { id: string };
  audit: { findings: Array<{ code: string; severity: string; evidence: Array<{ code: string; value: string }> }> } | null;
}

/**
 * Descarga como lo haria el navegador. Los hosts `*.localhost` de Garage solo
 * los resuelve el navegador: aqui se pide a 127.0.0.1 con su cabecera Host.
 */
function download(raw: string): Promise<{ status: number; bytes: number }> {
  const url = new URL(raw);
  const local = url.hostname.endsWith('.localhost');
  return new Promise((resolve, reject) => {
    const request = get(
      { host: local ? '127.0.0.1' : url.hostname, port: url.port || 80, path: `${url.pathname}${url.search}`, headers: { host: url.host } },
      (response) => {
        let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; });
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, bytes }); });
      },
    );
    request.on('error', reject);
  });
}

const VASE = {
  description: 'Jarron torneado de cuello corto y vientre ancho, con engobe rojizo.',
  materials: 'Ceramica',
  representationKind: 'THREE_D',
  widthCm: 32,
  heightCm: 50,
  depthCm: 32,
};

// Modelo 3D opcional de un objeto: el vendedor sube un GLB, catalog lo valida y
// lo mide, la ficha lo muestra y la auditoria lo usa como evidencia.
describe('modelo 3D de una escultura', () => {
  let seller: Account;
  let admin: Account;
  let vase: string;

  before(async () => {
    seller = await register('ceramista', 'SELLER');
    admin = await seedAccount(process.env['E2E_ADMIN_EMAIL'] ?? 'admin@artauction.local');
  });

  const lotOf = (lotId: string) => call<LotView>('GET', `/lots/${lotId}`, { token: seller.token });

  test('el vendedor sube el GLB de un jarron: catalog lo mide y la ficha lo trae', async () => {
    vase = await createLotWithImage(seller, { ...VASE, title: 'E2E Jarron con modelo' }, 61);
    const file = vaseGlb();
    const registered = await uploadModel(seller, vase, file);
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const model = registered.body as ModelView;
    assert.equal(model.triangleCount, 2304);
    assert.equal(model.bytes, file.length);
    assert.ok(Math.abs(model.size.y - 0.5) < 1e-6, `alto medido ${String(model.size.y)}`);

    const sheet = await lotOf(vase);
    assert.ok(sheet.body.model?.url, 'la ficha no trae la URL del modelo');
    assert.equal(sheet.body.model.triangleCount, 2304);
    // El visor de la ficha y la sala lo cargan directo de Garage.
    const fetched = await download(sheet.body.model.url);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.bytes, file.length);
  });

  test('los limites del modelo: solo objetos, un GLB valido, entre 1.000 y 300.000 triangulos y solo su propia clave', async () => {
    const painting = await createLotWithImage(seller, { title: 'E2E Lienzo sin modelo', description: 'Paisaje de montana al atardecer.', materials: 'Oleo sobre lienzo' }, 62);
    assert.equal((await uploadModel(seller, painting, vaseGlb())).status, 409, 'una obra plana no lleva modelo 3D');

    // 8 segmentos x 4 anillos = 64 triangulos: por debajo del minimo.
    const coarse = await uploadModel(seller, vase, vaseGlb(8, 4));
    assert.equal(coarse.status, 400);
    const notGlb = await uploadModel(seller, vase, Buffer.from('esto no es un modelo 3D, es texto plano'));
    assert.equal(notGlb.status, 400);
    const foreign = await call('POST', `/lots/${vase}/model`, { token: seller.token, body: { objectKey: `lots/${painting}/model-ajeno.glb` } });
    assert.equal(foreign.status, 400, 'no se registra la clave de otra obra');
    const wrongType = await call('POST', `/lots/${vase}/model-uploads`, { token: seller.token, body: { contentType: 'model/gltf+json' } });
    assert.equal(wrongType.status, 400);
    const stranger = await register('curioso', 'SELLER');
    assert.equal((await uploadModel(stranger, vase, vaseGlb())).status, 404, 'otra cuenta no toca el modelo');

    // Los intentos fallidos no cambian el modelo valido.
    assert.equal((await lotOf(vase)).body.model?.triangleCount, 2304);
  });

  test('quitar el modelo de un borrador lo saca de la ficha', async () => {
    const draft = await createLotWithImage(seller, { ...VASE, title: 'E2E Jarron sin modelo' }, 63);
    assert.equal((await uploadModel(seller, draft, vaseGlb())).status, 201);
    assert.equal((await call('DELETE', `/lots/${draft}/model`, { token: seller.token })).status, 204);
    assert.equal((await lotOf(draft)).body.model, null);
  });

  test('la auditoria usa el modelo como evidencia y avisa si sus proporciones no cuadran', async () => {
    // Declarada el doble de ancha que alta, con un modelo mas alto que ancho. El
    // acrilico en 1910 es un anacronismo: las reglas la mandan siempre a revision
    // manual, con o sin IA, y su expediente queda en la cola del administrador.
    const mismatch = await createLotWithImage(
      seller,
      { ...VASE, title: 'E2E Jarron mal medido', materials: 'Acrilico sobre ceramica', creationYear: 1910, widthCm: 100, heightCm: 50, depthCm: 100 },
      64,
    );
    assert.equal((await uploadModel(seller, mismatch, vaseGlb())).status, 201);
    assert.equal((await call('POST', `/lots/${mismatch}/submit`, { token: seller.token })).status, 201);
    await eventually('la obra queda en revision manual', async () => (await lotOf(mismatch)).body.status === 'REVISION_MANUAL');

    const queue = await call<ReviewItem[]>('GET', '/admin/reviews', { token: admin.token });
    const findings = queue.body.find((item) => item.lot.id === mismatch)?.audit?.findings ?? [];
    const proportions = findings.find((finding) => finding.code === 'MODEL_PROPORTIONS_MISMATCH');
    assert.ok(proportions, `sin aviso de proporciones: ${findings.map((finding) => finding.code).join(', ')}`);
    assert.equal(proportions.severity, 'WARNING');
    const evidence = new Map(proportions.evidence.map((item) => [item.code, item.value]));
    assert.match(evidence.get('model.size') ?? '', /0\.320 x 0\.500 x 0\.320/);
    assert.match(evidence.get('lot.declared_size') ?? '', /100 x 50 x 100 cm/);

    // Una obra en auditoria no cambia de modelo.
    assert.equal((await uploadModel(seller, mismatch, vaseGlb())).status, 409);
  });
});
