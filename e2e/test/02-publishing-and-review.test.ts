import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { call, eventually, publishLot, register, seedAccount, type Account } from '../src/platform.ts';

interface LotView {
  id: string;
  status: string;
  visibility: string;
  authenticityScore: number | null;
  suggestedPriceMin: string | null;
  suggestedPriceMax: string | null;
  auction: { status: string } | null;
  auditSummaries?: Array<{ verdict: string; modelName: string; hasCriticalInconsistency: boolean }>;
  lastReview?: { decision: string; reason: string | null } | null;
}

interface Notice {
  kind: string;
  payload: Record<string, string | null>;
}

interface ReviewItem {
  lot: { id: string };
  audit: { decidedBy: string | null; findings: Array<{ code: string; severity: string; evidence: Array<{ code: string; value: string }> }> } | null;
}

// Si Gemini no responde, ai-service agota dos timeouts antes de usar la
// evaluacion local: la espera de una auditoria con modelo es mas larga.
const AUDIT_TIMEOUT_MS = 120_000;

describe('publicar, auditar y revisar', () => {
  let seller: Account;
  let admin: Account;
  let cleanLot: string;
  let conflictLot: string;
  let returnedLot: string;

  before(async () => {
    seller = await register('vendedor', 'SELLER');
    admin = await seedAccount(process.env['E2E_ADMIN_EMAIL'] ?? 'admin@artauction.local');
  });

  const lotOf = (lotId: string) => call<LotView>('GET', `/lots/${lotId}`, { token: seller.token });

  test('una obra coherente pasa las reglas, la evalua el modelo y si se publica recibe su subasta', async () => {
    cleanLot = await publishLot(
      seller,
      {
        title: 'E2E Puerto al amanecer',
        description: 'Oleo de un puerto pesquero al amanecer, con barcas varadas y la luz rasante sobre el agua.',
        materials: 'Oleo sobre lienzo',
        creationYear: 1925,
        artistName: 'Taller E2E',
        provenance: 'Coleccion particular desde 1950, con factura de la galeria original.',
      },
      11,
    );
    const decided = await eventually('la auditoria decide la obra', async () => {
      const lot = await lotOf(cleanLot);
      return ['PUBLICADA', 'REVISION_MANUAL'].includes(lot.body.status) ? lot.body : null;
    }, AUDIT_TIMEOUT_MS);
    const summary = decided.auditSummaries?.[0];
    assert.ok(summary, 'la obra no tiene resumen de auditoria');
    // Sin GEMINI_API_KEY (como en CI) decide la evaluacion local, que es
    // determinista y aprueba. Con Gemini el veredicto es del modelo: la prueba
    // solo exige que lo haya decidido el, sin conflictos de las reglas.
    if (summary.modelName === 'local-rules') {
      assert.equal(decided.status, 'PUBLICADA');
    }
    if (decided.status === 'PUBLICADA') {
      assert.equal(decided.visibility, 'PUBLIC');
      assert.equal(summary.verdict, 'APROBADO');
      assert.ok((decided.authenticityScore ?? 0) >= 40);
      await eventually('auction-service programa la sala', async () => (await lotOf(cleanLot)).body.auction?.status === 'PROGRAMADA');
      return;
    }
    // Con Gemini sin cuota o caido decide la evaluacion local (LOCAL), que
    // manda a revision manual cualquier advertencia. Lo que no puede pasar es
    // que una regla critica frene una obra coherente.
    const queue = await call<ReviewItem[]>('GET', '/admin/reviews', { token: admin.token });
    const entry = queue.body.find((item) => item.lot.id === cleanLot);
    assert.ok(['AI', 'LOCAL'].includes(entry?.audit?.decidedBy ?? ''), 'una obra coherente no debe frenarse por las reglas');
  });

  test('un anacronismo va a revision manual sin consultar a la IA', async () => {
    conflictLot = await publishLot(
      seller,
      { title: 'E2E Retrato anacronico', description: 'Retrato de una dama con abanico y encaje.', materials: 'Acrilico sobre tela', creationYear: 1910 },
      12,
    );
    const reviewed = await eventually('la obra queda en revision manual', async () => {
      const lot = await lotOf(conflictLot);
      return lot.body.status === 'REVISION_MANUAL' ? lot.body : null;
    });
    assert.equal(reviewed.visibility, 'PRIVATE');
    const notice = await eventually('el vendedor recibe el aviso de la auditoria', async () => {
      const notes = await call<Notice[]>('GET', '/notifications', { token: seller.token });
      return notes.body.find((note) => note.kind === 'AUDIT' && note.payload['lotId'] === conflictLot);
    });
    assert.equal(notice.payload['verdict'], 'REVISION_MANUAL');
  });

  test('el administrador decide desde la cola con el expediente de evidencias', async () => {
    const forbidden = await call('GET', '/admin/reviews', { token: seller.token });
    assert.equal(forbidden.status, 403);
    const queue = await call<ReviewItem[]>('GET', '/admin/reviews', { token: admin.token });
    const entry = queue.body.find((item) => item.lot.id === conflictLot);
    assert.ok(entry, 'la obra no esta en la cola');
    assert.ok(entry.audit, 'la obra llega sin expediente');
    assert.equal(entry.audit.decidedBy, 'RULES');
    const finding = entry.audit.findings.find((item) => item.code === 'MATERIAL_ANACHRONISM');
    assert.ok(finding, 'falta el hallazgo MATERIAL_ANACHRONISM');
    assert.equal(finding.severity, 'CRITICAL');
    assert.deepEqual(
      finding.evidence.find((item) => item.code === 'lot.declared_year'),
      { code: 'lot.declared_year', value: '1910' },
    );

    // Una regla decidio sin estimar precio: aprobar exige que el administrador fije el rango.
    const unpriced = await call('POST', `/admin/lots/${conflictLot}/resolve`, { token: admin.token, body: { verdict: 'APROBADO' } });
    assert.equal(unpriced.status, 400);
    const inverted = await call('POST', `/admin/lots/${conflictLot}/resolve`, { token: admin.token, body: { verdict: 'APROBADO', priceMin: 500, priceMax: 300 } });
    assert.equal(inverted.status, 400);
    const resolved = await call<LotView>('POST', `/admin/lots/${conflictLot}/resolve`, {
      token: admin.token,
      body: { verdict: 'APROBADO', priceMin: 300, priceMax: 500 },
    });
    assert.equal(resolved.body.status, 'PUBLICADA');
    assert.equal(Number(resolved.body.suggestedPriceMin), 300);
    assert.equal(Number(resolved.body.suggestedPriceMax), 500);
    const after = await call<ReviewItem[]>('GET', '/admin/reviews', { token: admin.token });
    assert.ok(!after.body.some((item) => item.lot.id === conflictLot));
    await eventually('la obra aprobada recibe su subasta', async () => (await lotOf(conflictLot)).body.auction?.status === 'PROGRAMADA');
  });

  test('una obra devuelta vuelve al vendedor con el motivo, la corrige y la reenvia', async () => {
    const fields = { title: 'E2E Retrato devuelto', description: 'Retrato de un musico con su violin.', materials: 'Acrilico sobre tela', creationYear: 1905 };
    returnedLot = await publishLot(seller, fields, 13);
    await eventually('la obra queda en revision manual', async () => (await lotOf(returnedLot)).body.status === 'REVISION_MANUAL');

    const unexplained = await call('POST', `/admin/lots/${returnedLot}/resolve`, { token: admin.token, body: { verdict: 'BORRADOR' } });
    assert.equal(unexplained.status, 400);
    const reason = 'El acrilico no existia en 1905: revisa el año o los materiales.';
    const returned = await call<LotView>('POST', `/admin/lots/${returnedLot}/resolve`, { token: admin.token, body: { verdict: 'BORRADOR', reason } });
    assert.equal(returned.body.status, 'BORRADOR');
    assert.equal(returned.body.visibility, 'PRIVATE');

    const notice = await eventually('el vendedor recibe el aviso con el motivo', async () => {
      const notes = await call<Notice[]>('GET', '/notifications', { token: seller.token });
      return notes.body.find((note) => note.kind === 'LOT_RETURNED' && note.payload['lotId'] === returnedLot);
    });
    assert.equal(notice.payload['reason'], reason);
    const mine = await call<LotView[]>('GET', '/lots/mine', { token: seller.token });
    const listed = mine.body.find((lot) => lot.id === returnedLot);
    assert.equal(listed?.lastReview?.decision, 'RETURN_TO_DRAFT');
    assert.equal(listed.lastReview.reason, reason);

    // Solo el vendedor edita, y solo en borrador.
    const edit = { ...fields, categorySlug: 'pinturas', representationKind: 'TWO_D', widthCm: 120, heightCm: 90, creationYear: 2015 };
    const stranger = await call('PATCH', `/lots/${returnedLot}`, { token: admin.token, body: edit });
    assert.equal(stranger.status, 404);
    const edited = await call<LotView & { creationYear: number }>('PATCH', `/lots/${returnedLot}`, { token: seller.token, body: edit });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.creationYear, 2015);

    const resubmitted = await call('POST', `/lots/${returnedLot}/submit`, { token: seller.token });
    assert.equal(resubmitted.status, 201);
    const locked = await call('PATCH', `/lots/${returnedLot}`, { token: seller.token, body: edit });
    assert.ok(locked.status >= 400, 'una obra en auditoria no se edita');

    // La nueva auditoria ve la ficha corregida: el anacronismo ya no esta.
    const decided = await eventually('la auditoria decide la obra corregida', async () => {
      const lot = await lotOf(returnedLot);
      const summary = lot.body.auditSummaries?.[0];
      return ['PUBLICADA', 'REVISION_MANUAL'].includes(lot.body.status) && summary && !summary.hasCriticalInconsistency ? lot.body : null;
    }, AUDIT_TIMEOUT_MS);
    assert.ok(decided);
  });

  test('las obras propias entran en la galeria del vendedor y el publico solo ve las publicadas', async () => {
    const own = await eventually('gallery-service recibe LotCreated', async () => {
      const items = await call<Array<{ lotId: string | null; source: string }>>('GET', `/galleries/${seller.userId}`, { token: seller.token });
      const lotIds = items.body.filter((item) => item.source === 'PROPIA').map((item) => item.lotId);
      return lotIds.includes(cleanLot) && lotIds.includes(conflictLot) ? lotIds : null;
    });
    assert.ok(own.length >= 2);
    const anonymous = await call<Array<{ visibility: string }>>('GET', `/galleries/${seller.userId}`);
    assert.ok(anonymous.body.every((item) => item.visibility === 'PUBLIC'), 'lo que aun no se publica no se ve');

    const published = await call<{ status: string }>('GET', `/lots/${cleanLot}`, { token: seller.token });
    if (published.body.status === 'PUBLICADA') {
      await eventually('LotListed lleva la obra publicada a la galeria publica', async () => {
        const items = await call<Array<{ lotId: string | null }>>('GET', `/galleries/${seller.userId}`);
        return items.body.some((item) => item.lotId === cleanLot);
      });
    }
  });
});
