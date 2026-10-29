import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { call, eventually, publishLot, register, seedAccount, type Account } from '../src/platform.ts';

interface LotView {
  id: string;
  status: string;
  visibility: string;
  authenticityScore: number | null;
  auction: { status: string } | null;
  auditSummaries?: Array<{ verdict: string; modelName: string }>;
}

interface ReviewItem {
  lot: { id: string };
  audit: { decidedBy: string | null; findings: Array<{ code: string; severity: string; evidence: Array<{ code: string; value: string }> }> } | null;
}

describe('publicar, auditar y revisar', () => {
  let seller: Account;
  let admin: Account;
  let cleanLot: string;
  let conflictLot: string;

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
    });
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
    const queue = await call<ReviewItem[]>('GET', '/admin/reviews', { token: admin.token });
    const entry = queue.body.find((item) => item.lot.id === cleanLot);
    assert.equal(entry?.audit?.decidedBy, 'AI', 'una obra coherente no debe frenarse por las reglas');
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
      const notes = await call<Array<{ kind: string; payload: Record<string, string | null> }>>('GET', '/notifications', { token: seller.token });
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

    const resolved = await call<{ status: string }>('POST', `/admin/lots/${conflictLot}/resolve`, { token: admin.token, body: { verdict: 'APROBADO' } });
    assert.equal(resolved.body.status, 'PUBLICADA');
    const after = await call<ReviewItem[]>('GET', '/admin/reviews', { token: admin.token });
    assert.ok(!after.body.some((item) => item.lot.id === conflictLot));
    await eventually('la obra aprobada recibe su subasta', async () => (await lotOf(conflictLot)).body.auction?.status === 'PROGRAMADA');
  });

  test('las obras propias entran en la galeria del vendedor y solo el las ve', async () => {
    const own = await eventually('gallery-service recibe LotCreated', async () => {
      const items = await call<Array<{ lotId: string | null; source: string }>>('GET', `/galleries/${seller.userId}`, { token: seller.token });
      const lotIds = items.body.filter((item) => item.source === 'PROPIA').map((item) => item.lotId);
      return lotIds.includes(cleanLot) && lotIds.includes(conflictLot) ? lotIds : null;
    });
    assert.ok(own.length >= 2);
    const anonymous = await call<unknown[]>('GET', `/galleries/${seller.userId}`);
    assert.equal(anonymous.body.length, 0);
  });
});
