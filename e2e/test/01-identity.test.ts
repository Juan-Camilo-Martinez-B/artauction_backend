import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BASE_URL, call, register, RUN_ID } from '../src/platform.ts';

describe('gateway e identidad', () => {
  test('el gateway responde y publica su contrato OpenAPI', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
    const docs = await call<{ paths: Record<string, unknown> }>('GET', '/docs-json');
    assert.equal(docs.status, 200);
    for (const path of ['/auth/login', '/lots', '/auctions/{id}/bids', '/wallet/top-ups', '/me/gallery', '/admin/reviews']) {
      assert.ok(path in docs.body.paths, `falta ${path} en OpenAPI`);
    }
  });

  test('registro, login, sesion y renovacion del token', async () => {
    const seller = await register('identidad', 'SELLER');
    const me = await call<{ email: string; role: string }>('GET', '/auth/me', { token: seller.token });
    assert.equal(me.body.role, 'SELLER');
    assert.equal(me.body.email, seller.email);

    const duplicate = await call('POST', '/auth/register', {
      body: { email: seller.email, password: 'E2ePassword!2026', displayName: 'Duplicado' },
    });
    assert.equal(duplicate.status, 409);

    const wrong = await call('POST', '/auth/login', { body: { email: seller.email, password: 'otra-contrasena-mala' } });
    assert.equal(wrong.status, 401);

    const tokens = await call<{ refreshToken: string }>('POST', '/auth/login', { body: { email: seller.email, password: 'E2ePassword!2026' } });
    const refreshed = await call<{ accessToken: string }>('POST', '/auth/refresh', { body: { refreshToken: tokens.body.refreshToken } });
    assert.equal(refreshed.status, 200);
    assert.equal((await call('GET', '/auth/me', { token: refreshed.body.accessToken })).status, 200);
  });

  test('sin token no hay datos privados y los errores llegan con su codigo', async () => {
    assert.equal((await call('GET', '/wallet')).status, 401);
    assert.equal((await call('GET', '/auth/me', { token: 'no-es-un-token' })).status, 401);
    assert.equal((await call('GET', `/ruta-inexistente-${RUN_ID}`)).status, 404);
    assert.equal((await call('POST', '/auth/login', { body: { email: 'no-es-correo' } })).status, 400);
    const malformed = await fetch(`${BASE_URL}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":' });
    assert.equal(malformed.status, 400);
  });
});
